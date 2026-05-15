import { Injectable, Logger } from '@nestjs/common';
import {
  CaseEventKind,
  CaseStatus,
  type Case,
  type ChaseScheduleEntry,
  ChaseStage,
  type Charge,
  CommunicationChannel,
  CommunicationDirection,
  CommunicationStatus,
  type OrganisationConfig,
  RecipientRole,
  ReviewItemKind,
  ReviewItemPriority,
  type Tenancy,
  type TenancyContact,
  type Contact,
  type Communication,
} from '@prisma/client';
import { Clock } from '../../../common/clock/clock.service';
import { PrismaService } from '../../../integrations/prisma/prisma.service';
import { STAGE_SEVERITY } from '../chase-thresholds';
import { renderTemplate, type TemplateContext } from './template-renderer';

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export interface DigestRunResult {
  casesEvaluated: number;
  digestsCreated: number;
  entriesFired: number;
}

interface CaseWithContext extends Case {
  tenancy: Tenancy & {
    tenancyContacts: (TenancyContact & { contact: Contact })[];
  };
  charges: Charge[];
  chaseScheduleEntries: ChaseScheduleEntry[];
  organisation: { config: OrganisationConfig | null };
}

const ARREARS_STATUSES = new Set(['UNPAID', 'PARTIALLY_PAID', 'PARTIALLY_RECONCILED']);

const TEMPLATE_BY_STAGE: Record<ChaseStage, keyof OrganisationConfig | null> = {
  AWAITING_WD3: 'templateWd3Tenant',
  AWAITING_WD5: 'templateWd5Tenant',
  AWAITING_WD8: 'templateWd8Tenant',
  AWAITING_WD14: 'templateWd14Tenant',
  NOT_DUE: null,
  WD3_SENT: null,
  WD5_SENT: null,
  WD8_SENT: null,
  WD14_NOTIFIED: null,
  RESOLVED: null,
};

const SUBJECT_BY_STAGE: Record<ChaseStage, string> = {
  AWAITING_WD3: 'Reminder: outstanding rent',
  AWAITING_WD5: 'Rent overdue — please contact us',
  AWAITING_WD8: 'Formal notice: outstanding rent',
  AWAITING_WD14: 'Outstanding rent — final notice',
  NOT_DUE: 'Rent reminder',
  WD3_SENT: 'Rent reminder',
  WD5_SENT: 'Rent reminder',
  WD8_SENT: 'Rent reminder',
  WD14_NOTIFIED: 'Rent reminder',
  RESOLVED: 'Rent reminder',
};

/**
 * Daily-digest job per docs/business-rules.md R4.
 *
 * For each case that has at least one unfired ChaseScheduleEntry whose
 * dueAt has passed:
 *   1. Pick the most severe AWAITING_* among the firing entries (R4.2).
 *   2. Render the matching template (R4.3 — body itemises every overdue
 *      charge on the case, not just the firing ones).
 *   3. Create a Communication(direction=OUTBOUND, channel=EMAIL,
 *      status=AWAITING_APPROVAL, draftedByAi=false,
 *      consolidatedStage=...) linked to every overdue charge.
 *   4. Mark all included entries firedAt=now (R4.4).
 *   5. Create a ReviewQueueItem(kind=OUTBOUND_DRAFT_APPROVAL); priority
 *      HIGH if WD14 is in the bundle, URGENT if the case is S8 eligible,
 *      NORMAL otherwise (R4.4).
 *   6. Emit CHASE_EVENT_FIRED + COMMUNICATION_DRAFTED CaseEvents.
 *
 * R4.5 (breathing space) is enforced at the chase-tick layer — entries on
 * breathing-space cases are written with skippedReason set and firedAt
 * already filled. They never appear in our `firedAt IS NULL` query so we
 * don't need to filter again here.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async runDigest(now?: Date): Promise<DigestRunResult> {
    const digestNow = now ?? this.clock.now();
    const cases = await this.findCasesWithFiringEntries(digestNow);
    let digestsCreated = 0;
    let entriesFired = 0;
    for (const c of cases) {
      try {
        const r = await this.processCase(c, digestNow);
        if (r.digestCreated) digestsCreated++;
        entriesFired += r.entriesFired;
      } catch (err) {
        this.logger.error(
          `digest: case ${c.id} failed — ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return { casesEvaluated: cases.length, digestsCreated, entriesFired };
  }

  private async findCasesWithFiringEntries(now: Date): Promise<CaseWithContext[]> {
    const caseIds = await this.prisma.chaseScheduleEntry.findMany({
      where: { firedAt: null, skippedReason: null, dueAt: { lte: now } },
      select: { caseId: true },
      distinct: ['caseId'],
    });
    if (caseIds.length === 0) return [];
    return this.prisma.case.findMany({
      where: {
        id: { in: caseIds.map((c) => c.caseId) },
        status: CaseStatus.ACTIVE,
      },
      include: {
        tenancy: { include: { tenancyContacts: { include: { contact: true } } } },
        charges: true,
        chaseScheduleEntries: true,
        organisation: { include: { config: true } },
      },
    });
  }

  private async processCase(
    c: CaseWithContext,
    now: Date,
  ): Promise<{ digestCreated: boolean; entriesFired: number }> {
    const config = c.organisation.config;
    if (!config) {
      this.logger.warn(`digest: case ${c.id} has no org config; skipping`);
      return { digestCreated: false, entriesFired: 0 };
    }

    const firing = c.chaseScheduleEntries.filter(
      (e) => e.firedAt == null && e.skippedReason == null && e.dueAt <= now,
    );
    if (firing.length === 0) return { digestCreated: false, entriesFired: 0 };

    const consolidatedStage = mostSevereStage(firing.map((e) => e.stage));
    const templateKey = TEMPLATE_BY_STAGE[consolidatedStage];
    if (!templateKey) {
      this.logger.warn(`digest: case ${c.id} consolidated stage ${consolidatedStage} has no template`);
      return { digestCreated: false, entriesFired: 0 };
    }
    const templateBody = (config as unknown as Record<string, unknown>)[templateKey] as string;

    const overdueCharges = c.charges.filter((ch) => ARREARS_STATUSES.has(ch.lastKnownStatus));
    if (overdueCharges.length === 0) {
      this.logger.warn(
        `digest: case ${c.id} firing entries exist but no overdue charges on case`,
      );
      return { digestCreated: false, entriesFired: 0 };
    }

    const tenantContact = c.tenancy.tenancyContacts.find((tc) => tc.role === 'TENANT')?.contact;
    if (!tenantContact?.primaryEmail) {
      this.logger.warn(`digest: case ${c.id} has no tenant primary email; skipping draft`);
      return { digestCreated: false, entriesFired: 0 };
    }

    const context = buildContext(c, overdueCharges, tenantContact);
    let body: string;
    try {
      body = renderTemplate(templateBody, context);
    } catch (err) {
      this.logger.error(
        `digest: case ${c.id} template render failed — ${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }

    const subject = SUBJECT_BY_STAGE[consolidatedStage];
    const priority = pickPriority(firing, c.s8Eligible);

    const result = await this.prisma.$transaction(async (tx) => {
      const comm = await tx.communication.create({
        data: {
          caseId: c.id,
          organisationId: c.organisationId,
          direction: CommunicationDirection.OUTBOUND,
          channel: CommunicationChannel.EMAIL,
          status: CommunicationStatus.AWAITING_APPROVAL,
          consolidatedStage,
          recipientRole: RecipientRole.TENANT,
          toAddress: tenantContact.primaryEmail,
          subject,
          bodyMarkdown: body,
          draftedByAi: false,
          charges: { connect: overdueCharges.map((ch) => ({ id: ch.id })) },
        },
      });

      await tx.chaseScheduleEntry.updateMany({
        where: { id: { in: firing.map((e) => e.id) } },
        data: { firedAt: now },
      });

      await tx.reviewQueueItem.create({
        data: {
          organisationId: c.organisationId,
          caseId: c.id,
          kind: ReviewItemKind.OUTBOUND_DRAFT_APPROVAL,
          communicationId: comm.id,
          priority,
        },
      });

      await tx.caseEvent.createMany({
        data: [
          ...firing.map((e) => ({
            caseId: c.id,
            kind: CaseEventKind.CHASE_EVENT_FIRED,
            payloadJson: {
              chaseScheduleEntryId: e.id,
              chargeId: e.chargeId,
              stage: e.stage,
              communicationId: comm.id,
            },
            occurredAt: now,
          })),
          {
            caseId: c.id,
            kind: CaseEventKind.COMMUNICATION_DRAFTED,
            payloadJson: {
              communicationId: comm.id,
              consolidatedStage,
              priority,
              chargeIds: overdueCharges.map((ch) => ch.id),
              entryIds: firing.map((e) => e.id),
            },
            occurredAt: now,
          },
        ],
      });

      return { comm };
    });
    void result;
    return { digestCreated: true, entriesFired: firing.length };
  }
}

function mostSevereStage(stages: ChaseStage[]): ChaseStage {
  return stages.reduce<ChaseStage>(
    (acc, s) => (STAGE_SEVERITY[s] > STAGE_SEVERITY[acc] ? s : acc),
    ChaseStage.NOT_DUE,
  );
}

function pickPriority(
  firing: ChaseScheduleEntry[],
  s8Eligible: boolean,
): ReviewItemPriority {
  if (s8Eligible) return ReviewItemPriority.URGENT;
  if (firing.some((e) => e.stage === ChaseStage.AWAITING_WD14)) return ReviewItemPriority.HIGH;
  return ReviewItemPriority.NORMAL;
}

function buildContext(
  c: CaseWithContext,
  overdueCharges: Charge[],
  tenantContact: Contact,
): TemplateContext {
  const balancePence = overdueCharges.reduce(
    (acc, ch) => acc + ch.lastKnownRemainAmountPence,
    0n,
  );
  const propertyAddress = [
    c.tenancy.propertyName,
    c.tenancy.propertyAddress1,
    c.tenancy.propertyAddress2,
  ]
    .filter(Boolean)
    .join(', ');
  const chargeLines = overdueCharges.map((ch) => ({
    referenceId: ch.lwcaInvoiceId,
    dueDateFormatted: DATE.format(ch.dueDate),
    grossAmountFormatted: GBP.format(Number(ch.grossAmountPence) / 100),
    remainAmountFormatted: GBP.format(Number(ch.lastKnownRemainAmountPence) / 100),
    workingDaysOverdue: ch.workingDaysOverdue,
  }));
  const mostOverdue = chargeLines.reduce(
    (acc, line) => (line.workingDaysOverdue > acc.workingDaysOverdue ? line : acc),
    chargeLines[0]!,
  );

  return {
    tenant: {
      firstName: tenantContact.firstName ?? '',
      lastName: tenantContact.lastName ?? '',
    },
    property: {
      address: propertyAddress,
      name: c.tenancy.propertyName ?? '',
    },
    case: {
      balanceFormatted: GBP.format(Number(balancePence) / 100),
      balancePence: Number(balancePence),
      chargeCount: overdueCharges.length,
      openedDate: DATE.format(c.openedAt),
    },
    charges: chargeLines,
    mostOverdueCharge: mostOverdue,
    agency: {
      // Step 5.3 will pull this from OrganisationConfig once those fields exist.
      name: 'Lettings agency',
      replyEmail: 'arrears@example.com',
    },
  };
}
