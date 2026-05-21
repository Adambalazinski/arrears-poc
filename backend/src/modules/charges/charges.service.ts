import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CaseEventKind,
  ChargeStatus,
  ChaseStage as ChaseStageEnumValues,
  type Charge,
  type ChaseStage,
  type OrganisationConfig,
  type Prisma,
} from '@prisma/client';
import { WorkingDayService } from '../../common/working-day/working-day.service';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import type { LwcaChargeUpsert } from '../../integrations/lwca/lwca-invoice.mapper';

export interface ChargeUpsertResult {
  charge: Charge;
  created: boolean;
}

/**
 * R8.2 step-back map. Each AWAITING_/SENT stage steps back one rung on
 * the chase ladder; AWAITING_WD3/WD3_SENT is the floor and step-back
 * returns null (handled by the at-floor "no stage change" branch).
 */
const STAGE_STEP_BACK: Partial<Record<ChaseStage, ChaseStage>> = {
  [ChaseStageEnumValues.AWAITING_WD14]: ChaseStageEnumValues.AWAITING_WD8,
  [ChaseStageEnumValues.WD14_NOTIFIED]: ChaseStageEnumValues.AWAITING_WD8,
  [ChaseStageEnumValues.AWAITING_WD8]: ChaseStageEnumValues.AWAITING_WD5,
  [ChaseStageEnumValues.WD8_SENT]: ChaseStageEnumValues.AWAITING_WD5,
  [ChaseStageEnumValues.AWAITING_WD5]: ChaseStageEnumValues.AWAITING_WD3,
  [ChaseStageEnumValues.WD5_SENT]: ChaseStageEnumValues.AWAITING_WD3,
};

const PARTIAL_PAY_ARREARS_STATUSES: ReadonlySet<ChargeStatus> = new Set([
  ChargeStatus.PARTIALLY_PAID,
  ChargeStatus.PARTIALLY_RECONCILED,
]);

const RESET_THRESHOLD = 0.9; // R8.2: cumulative paid ≥ 90% → reset

@Injectable()
export class ChargesService {
  private readonly logger = new Logger(ChargesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workingDay: WorkingDayService,
  ) {}

  /**
   * Idempotent upsert keyed by lwcaInvoiceId. First sync inserts; later
   * syncs update only the fields LWCA can legitimately change
   * (status, remain, payment cycle). grossAmountPence / dueDate /
   * invoiceDate are write-once per docs/canonical-data-model.md
   * ("grossAmount: immutable after first sync").
   *
   * Emits CHARGE_ADDED on create. The polling job decides whether to
   * also emit CHARGE_SYNCED on update — keeping that decision outside the
   * upsert so the timeline only records meaningful changes.
   */
  async upsertFromLwca(caseId: string, input: LwcaChargeUpsert): Promise<ChargeUpsertResult> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.charge.findUnique({
        where: { lwcaInvoiceId: input.lwcaInvoiceId },
        select: {
          id: true,
          caseId: true,
          grossAmountPence: true,
          lastKnownRemainAmountPence: true,
          lastKnownStatus: true,
          currentStage: true,
          cadenceCycle: true,
          case: {
            select: { organisation: { select: { config: true } } },
          },
        },
      });

      if (existing) {
        const charge = await tx.charge.update({
          where: { lwcaInvoiceId: input.lwcaInvoiceId },
          data: {
            lastKnownRemainAmountPence: input.lastKnownRemainAmountPence,
            lastKnownStatus: input.lastKnownStatus,
            lastKnownPaymentCycleType: input.lastKnownPaymentCycleType,
            lastKnownType: input.lastKnownType,
            lastKnownDescription: input.lastKnownDescription,
            lastSyncedAt: input.lastSyncedAt,
          },
        });
        await this.handlePartialPaymentIfTriggered(tx, existing, charge);
        return { charge, created: false };
      }

      const charge = await tx.charge.create({
        data: {
          caseId,
          organisationId: input.organisationId,
          lwcaInvoiceId: input.lwcaInvoiceId,
          dueDate: input.dueDate,
          invoiceDate: input.invoiceDate,
          grossAmountPence: input.grossAmountPence,
          lastKnownRemainAmountPence: input.lastKnownRemainAmountPence,
          lastKnownStatus: input.lastKnownStatus,
          lastKnownPaymentCycleType: input.lastKnownPaymentCycleType,
          lastKnownType: input.lastKnownType,
          lastKnownDescription: input.lastKnownDescription,
          lastSyncedAt: input.lastSyncedAt,
        },
      });

      await tx.caseEvent.create({
        data: {
          caseId,
          kind: CaseEventKind.CHARGE_ADDED,
          payloadJson: {
            chargeId: charge.id,
            lwcaInvoiceId: charge.lwcaInvoiceId,
            grossAmountPence: charge.grossAmountPence.toString(),
            lastKnownStatus: charge.lastKnownStatus,
            dueDate: charge.dueDate.toISOString(),
          },
        },
      });
      return { charge, created: true };
    });
  }

  /**
   * R8.1 + R8.2: detect partial-payment delta against the pre-update state
   * and apply cadence consequences.
   *
   * R8.1 — always emit CHARGE_PARTIALLY_PAID for an actual remain decrease
   * on an arrears-status charge.
   *
   * R8.2 — cadence step-back / reset:
   *   - cumulative paid ≥ 90% of gross → reset (cycle++, anchor=now,
   *     currentStage=NOT_DUE). 3-WD grace before any new chase fires.
   *   - cumulative paid <  90% of gross → step back one stage (cycle++,
   *     anchor = now − (target stage WD) working days, currentStage=NOT_DUE).
   *     Next chase tick will re-discover the target stage and fire it.
   *   - already at WD3 floor → no cadence change. The partial-pay fact
   *     is still recorded.
   *
   * The cycle bump lets ChaseScheduleEntry's (chargeId, cycle, stage, role)
   * unique index permit a fresh entry at the same stage without colliding
   * with the previous cycle's entry.
   */
  private async handlePartialPaymentIfTriggered(
    tx: Prisma.TransactionClient,
    previous: {
      id: string;
      caseId: string;
      grossAmountPence: bigint;
      lastKnownRemainAmountPence: bigint;
      lastKnownStatus: ChargeStatus;
      currentStage: ChaseStage;
      cadenceCycle: number;
      case: { organisation: { config: OrganisationConfig | null } };
    },
    current: Charge,
  ): Promise<void> {
    // Only partial-pay statuses trigger R8.1/R8.2. Fully PAID closes via R2.
    if (!PARTIAL_PAY_ARREARS_STATUSES.has(current.lastKnownStatus)) return;
    // Must be an actual decrease — a no-op resync of identical data must
    // not double-emit events.
    if (current.lastKnownRemainAmountPence >= previous.lastKnownRemainAmountPence) return;

    const gross = current.grossAmountPence;
    if (gross <= 0n) return; // defensive — wouldn't have been ingested
    const remain = current.lastKnownRemainAmountPence;
    const deltaPence = previous.lastKnownRemainAmountPence - remain;
    const paidPence = gross - remain;

    // R8.1 — record the partial-pay fact.
    await tx.caseEvent.create({
      data: {
        caseId: current.caseId,
        kind: CaseEventKind.CHARGE_PARTIALLY_PAID,
        payloadJson: {
          chargeId: current.id,
          deltaPence: deltaPence.toString(),
          paidPence: paidPence.toString(),
          remainPence: remain.toString(),
          grossPence: gross.toString(),
        },
      },
    });

    // R8.2 — decide cadence consequence. NOT_DUE means cadence hasn't
    // started yet; there's nothing to step back from. RESOLVED would mean
    // a fully-paid charge, which we already excluded by status.
    if (
      previous.currentStage === ChaseStageEnumValues.NOT_DUE ||
      previous.currentStage === ChaseStageEnumValues.RESOLVED
    ) {
      return;
    }

    const paidRatio = Number(paidPence) / Number(gross);
    const config = previous.case.organisation.config;
    if (!config) {
      this.logger.warn(
        `partial-payment: skipping R8.2 for charge ${current.id} — org config missing`,
      );
      return;
    }

    const now = new Date();

    if (paidRatio >= RESET_THRESHOLD) {
      // Reset to WD3 with grace: anchor at today so wd-overdue starts at 0.
      // WD3 fires once 3 working days elapse, giving the cooperative payer
      // breathing room before the next chase.
      await tx.charge.update({
        where: { id: current.id },
        data: {
          cadenceCycle: { increment: 1 },
          cadenceAnchorAt: now,
          currentStage: ChaseStageEnumValues.NOT_DUE,
          currentStageEnteredAt: now,
          stageResetAt: now,
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: current.caseId,
          kind: CaseEventKind.CHARGE_CADENCE_RESET,
          payloadJson: {
            chargeId: current.id,
            paidRatio,
            previousStage: previous.currentStage,
            anchorAt: now.toISOString(),
            newCycle: previous.cadenceCycle + 1,
          },
        },
      });
      return;
    }

    // <90% paid: step back one rung. At the floor (WD3 / WD3_SENT), no
    // cadence change — the partial-pay event above is the only side effect.
    const targetStage = STAGE_STEP_BACK[previous.currentStage];
    if (!targetStage) return;

    const targetWd = wdForStage(targetStage, config);
    // Anchor today − targetWd working days so the next chase tick sees
    // wd-overdue = targetWd and creates the target stage's entry in the
    // new cycle. The working-day service is the only place that handles
    // weekends and bank holidays.
    const anchor = this.workingDay.subtractWorkingDays(now, targetWd);
    await tx.charge.update({
      where: { id: current.id },
      data: {
        cadenceCycle: { increment: 1 },
        cadenceAnchorAt: anchor,
        currentStage: ChaseStageEnumValues.NOT_DUE,
        currentStageEnteredAt: now,
        stageSteppedBackAt: now,
      },
    });
    await tx.caseEvent.create({
      data: {
        caseId: current.caseId,
        kind: CaseEventKind.CHARGE_CADENCE_STEPPED_BACK,
        payloadJson: {
          chargeId: current.id,
          paidRatio,
          previousStage: previous.currentStage,
          targetStage,
          anchorAt: anchor.toISOString(),
          newCycle: previous.cadenceCycle + 1,
        },
      },
    });
  }

  /**
   * Atomic stage advancement. Used by the chase tick job (R3.4): when a WD
   * threshold is crossed, the cadence engine moves Charge.currentStage and
   * records the entry time. Returns the updated row.
   */
  async advanceStage(chargeId: string, toStage: ChaseStage): Promise<Charge> {
    try {
      return await this.prisma.charge.update({
        where: { id: chargeId },
        data: {
          currentStage: toStage,
          currentStageEnteredAt: new Date(),
        },
      });
    } catch (err) {
      if (isRecordNotFound(err)) {
        throw new NotFoundException(`Charge ${chargeId} not found`);
      }
      throw err;
    }
  }

  findById(chargeId: string): Promise<Charge | null> {
    return this.prisma.charge.findUnique({ where: { id: chargeId } });
  }

  listByCase(caseId: string): Promise<Charge[]> {
    return this.prisma.charge.findMany({
      where: { caseId },
      orderBy: { dueDate: 'asc' },
    });
  }
}

function isRecordNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string };
  return e.code === 'P2025';
}

/**
 * R8.2 step-back targets resolve to a working-day count from the org's
 * configured cadence thresholds. Mirrors chase-thresholds.ts but doesn't
 * import it to avoid a chase→charges circular dependency.
 */
function wdForStage(stage: ChaseStage, config: OrganisationConfig): number {
  switch (stage) {
    case ChaseStageEnumValues.AWAITING_WD3:
      return config.chaseDayFirst;
    case ChaseStageEnumValues.AWAITING_WD5:
      return config.chaseDaySecond;
    case ChaseStageEnumValues.AWAITING_WD8:
      return config.chaseDayThird;
    case ChaseStageEnumValues.AWAITING_WD14:
      return config.chaseDayExecNotify;
    default:
      throw new Error(`wdForStage: not an AWAITING_* stage: ${stage}`);
  }
}

export type { LwcaChargeUpsert };
export type { ChaseStage as ChaseStageEnum, Charge as ChargeRow };
export type { Prisma };
