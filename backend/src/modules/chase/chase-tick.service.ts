import { Injectable, Logger } from '@nestjs/common';
import {
  CaseEventKind,
  CaseStatus,
  type ChargeStatus,
  ChaseSkippedReason,
  ChaseStage,
  type OrganisationConfig,
  type Prisma,
  PromiseStatus,
  RecipientRole,
} from '@prisma/client';
import { Clock } from '../../common/clock/clock.service';
import { WorkingDayService } from '../../common/working-day/working-day.service';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import {
  CHASE_THRESHOLDS,
  STAGE_SEVERITY,
  stagesCrossed,
  thresholdsFromConfig,
  type ChaseThreshold,
} from './chase-thresholds';
import { todayAt9LondonAsUtc } from './london-clock';

const ARREARS_CHARGE_STATUSES: ReadonlySet<ChargeStatus> = new Set([
  'UNPAID',
  'PARTIALLY_PAID',
  'PARTIALLY_RECONCILED',
]);

export interface ChaseTickResult {
  /** Distinct charges scanned (in arrears status, on an ACTIVE case). */
  scanned: number;
  /** New ChaseScheduleEntry rows created during this tick. */
  entriesCreated: number;
  /** Entries created with skippedReason=BREATHING_SPACE_ACTIVE. */
  entriesSkipped: number;
  /** Charges whose currentStage advanced. */
  stagesAdvanced: number;
}

/**
 * Per docs/business-rules.md R3:
 *   - For each charge in an arrears state on an ACTIVE case, recompute
 *     workingDaysOverdue (R3.3) and update Charge.workingDaysOverdue.
 *   - For each WD threshold (per OrganisationConfig) that's now crossed
 *     without an existing entry, create ChaseScheduleEntry with
 *     dueAt=today_09:00_London (R3.3).
 *   - Advance Charge.currentStage to the most severe AWAITING_* among
 *     unfired entries (R3.4).
 *   - R4.5: when Case.breathingSpaceActive, mark new entries
 *     skippedReason=BREATHING_SPACE_ACTIVE at creation (so the digest
 *     job skips them naturally).
 *
 * The (chargeId, stage) unique constraint makes the create idempotent —
 * re-running this tick within the same WD window is safe.
 */
@Injectable()
export class ChaseTickService {
  private readonly logger = new Logger(ChaseTickService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workingDay: WorkingDayService,
    private readonly clock: Clock,
  ) {}

  async runTick(now?: Date): Promise<ChaseTickResult> {
    const tickNow = now ?? this.clock.now();
    const charges = await this.prisma.charge.findMany({
      where: {
        lastKnownStatus: { in: Array.from(ARREARS_CHARGE_STATUSES) },
        case: { status: CaseStatus.ACTIVE },
      },
      include: {
        case: {
          select: {
            id: true,
            breathingSpaceActive: true,
            organisationId: true,
            organisation: { select: { config: true } },
            tenancy: {
              select: {
                tenancyContacts: {
                  where: { role: 'GUARANTOR' },
                  select: { contact: { select: { primaryEmail: true } } },
                },
              },
            },
            promises: {
              where: { status: PromiseStatus.ACTIVE },
              select: { id: true },
              take: 1,
            },
          },
        },
        chaseScheduleEntries: {
          select: { stage: true, recipientRole: true, firedAt: true, skippedReason: true },
        },
      },
    });

    let entriesCreated = 0;
    let entriesSkipped = 0;
    let stagesAdvanced = 0;
    const dueAt = todayAt9LondonAsUtc(tickNow);

    for (const c of charges) {
      const config = c.case.organisation.config;
      if (!config) {
        this.logger.warn(
          `chase-tick: skipping charge ${c.id} — org ${c.case.organisationId} has no config`,
        );
        continue;
      }
      const wd = this.workingDay.workingDaysOverdue(c.dueDate, tickNow);
      const thresholds = thresholdsFromConfig(config as OrganisationConfig);
      const crossed = stagesCrossed(wd, thresholds);
      const existingByKey = new Map(
        c.chaseScheduleEntries.map((e) => [`${e.stage}|${e.recipientRole}`, e]),
      );
      const breathingSpace = c.case.breathingSpaceActive;
      const promiseActive = c.case.promises.length > 0;

      // Whether to also emit a GUARANTOR-track entry for this charge. Only
      // create one if the tenancy has at least one guarantor with a
      // primary email — otherwise digest would fail to dispatch anyway.
      const hasGuarantorEmail = c.case.tenancy.tenancyContacts.some(
        (tc) => tc.contact.primaryEmail != null && tc.contact.primaryEmail.trim() !== '',
      );

      // Create entries for any newly-crossed stage that doesn't already
      // have a row (unique (chargeId, stage, recipientRole) constraint
      // also guards this). Promise-active pauses BOTH tracks (per the
      // product choice). Breathing space pauses only the tenant track.
      for (const stage of crossed) {
        if (!existingByKey.has(`${stage}|${RecipientRole.TENANT}`)) {
          const skip = promiseActive
            ? ChaseSkippedReason.PROMISE_ACTIVE
            : breathingSpace
              ? ChaseSkippedReason.BREATHING_SPACE_ACTIVE
              : null;
          await this.createEntry(c.caseId, c.id, stage, RecipientRole.TENANT, dueAt, skip);
          if (skip) entriesSkipped++;
          else entriesCreated++;
        }
        if (
          hasGuarantorEmail &&
          !existingByKey.has(`${stage}|${RecipientRole.GUARANTOR}`)
        ) {
          const skip = promiseActive ? ChaseSkippedReason.PROMISE_ACTIVE : null;
          await this.createEntry(c.caseId, c.id, stage, RecipientRole.GUARANTOR, dueAt, skip);
          if (skip) entriesSkipped++;
          else entriesCreated++;
        }
      }

      // Decide the new currentStage from the set of entries (existing +
      // freshly created). Highest AWAITING_* among unfired entries wins;
      // if none unfired, highest *_SENT/NOTIFIED of fired entries; else
      // NOT_DUE.
      const refreshed = await this.prisma.chaseScheduleEntry.findMany({
        where: { chargeId: c.id },
        select: { stage: true, firedAt: true, skippedReason: true },
      });
      const computed = computeCurrentStage(refreshed);
      const advance =
        STAGE_SEVERITY[computed] > STAGE_SEVERITY[c.currentStage] ||
        (computed !== c.currentStage && STAGE_SEVERITY[computed] >= STAGE_SEVERITY[c.currentStage]);

      await this.prisma.charge.update({
        where: { id: c.id },
        data: {
          workingDaysOverdue: wd,
          ...(advance && computed !== c.currentStage
            ? {
                currentStage: computed,
                currentStageEnteredAt: tickNow,
              }
            : {}),
        },
      });

      if (advance && computed !== c.currentStage) {
        stagesAdvanced++;
        await this.prisma.caseEvent.create({
          data: {
            caseId: c.caseId,
            kind: CaseEventKind.CHASE_STAGE_ADVANCED,
            payloadJson: {
              chargeId: c.id,
              fromStage: c.currentStage,
              toStage: computed,
              workingDaysOverdue: wd,
            },
            occurredAt: tickNow,
          },
        });
      }
    }

    return { scanned: charges.length, entriesCreated, entriesSkipped, stagesAdvanced };
  }

  private async createEntry(
    caseId: string,
    chargeId: string,
    stage: ChaseStage,
    recipientRole: RecipientRole,
    dueAt: Date,
    skippedReason: ChaseSkippedReason | null,
  ): Promise<void> {
    const data: Prisma.ChaseScheduleEntryCreateInput = {
      case: { connect: { id: caseId } },
      charge: { connect: { id: chargeId } },
      stage,
      recipientRole,
      dueAt,
      // Entries that come due during a paused state (R4.5 breathing space,
      // R10 active promise) are skipped at creation. firedAt is set so
      // the digest job's `firedAt=null` filter ignores them, just like
      // entries that have already fired.
      ...(skippedReason
        ? { skippedReason, firedAt: new Date() }
        : {}),
    };
    try {
      await this.prisma.chaseScheduleEntry.create({ data });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Another tick beat us to the same (chargeId, stage). Idempotent.
        return;
      }
      throw err;
    }
  }
}

function computeCurrentStage(
  entries: { stage: ChaseStage; firedAt: Date | null; skippedReason: string | null }[],
): ChaseStage {
  if (entries.length === 0) return ChaseStage.NOT_DUE;
  const unfired = entries.filter((e) => e.firedAt == null);
  if (unfired.length > 0) {
    // Pick the most severe AWAITING_*. (The chase tick only writes
    // AWAITING_* stages, so this is always an AWAITING_ value.)
    return unfired.reduce<ChaseStage>(
      (acc, e) => (STAGE_SEVERITY[e.stage] > STAGE_SEVERITY[acc] ? e.stage : acc),
      ChaseStage.NOT_DUE,
    );
  }
  // All entries fired (or skipped). Pick the *_SENT counterpart of the
  // most severe AWAITING_ entry.
  const mostSevereAwaiting = entries.reduce<ChaseStage>(
    (acc, e) => (STAGE_SEVERITY[e.stage] > STAGE_SEVERITY[acc] ? e.stage : acc),
    ChaseStage.NOT_DUE,
  );
  const map = new Map<ChaseStage, ChaseStage>(
    CHASE_THRESHOLDS.map((t) => [t.stage, t.sentStage] as const),
  );
  return map.get(mostSevereAwaiting) ?? ChaseStage.NOT_DUE;
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string };
  return e.code === 'P2002';
}
