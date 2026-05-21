import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CaseEventKind,
  CaseStatus,
  ChaseSkippedReason,
  CommunicationChannel,
  CommunicationDirection,
  CommunicationStatus,
  Prisma,
  type Promise as PromiseRow,
  PromiseStatus,
  RecipientRole,
  ReviewItemKind,
  ReviewItemPriority,
} from '@prisma/client';
import { Clock } from '../../common/clock/clock.service';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import { renderTemplate, type TemplateContext } from '../chase/digest/template-renderer';

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export interface CreatePromiseInput {
  caseId: string;
  promiseDate: Date;
  createdByUserId: string;
  note?: string;
  sourceInboundCommunicationId?: string;
}

export interface ResolvePromiseInput {
  promiseId: string;
  resolvedByUserId: string;
  note?: string;
}

export interface CreatePromiseResult {
  promise: PromiseRow;
  chaseEntriesSkipped: number;
  draftsAutoRejected: number;
}

/**
 * Payment promise lifecycle (CLAUDE.md item 10).
 *
 * Lifecycle:
 *   ACTIVE -> FULFILLED  (handler marks)
 *   ACTIVE -> CANCELLED  (handler cancels)
 *   ACTIVE -> BROKEN     (PromiseExpiryJob, when promiseDate passes)
 *
 * Validation on create (R10 — derived from the post-MVP one-liner in
 * business-rules.md:257):
 *   - Case must be ACTIVE.
 *   - At most one ACTIVE promise per case.
 *   - promiseDate within 15 days of creation (BRD ceiling).
 *   - At most two promises (any status) in the last 30 days on this case.
 *
 * Cascade on create:
 *   - All pending ChaseScheduleEntry rows (both tenant and guarantor
 *     tracks) marked skipped with reason PROMISE_ACTIVE. Future entries
 *     created during the window get the same treatment via ChaseTickService.
 *   - All pending OUTBOUND drafts on the case (AWAITING_APPROVAL +
 *     APPROVED, both recipient roles) auto-rejected with reason
 *     "promise active".
 *   - CaseEvent PROMISE_CREATED emitted.
 *
 * S8 is NOT cleared by an active promise — a tenant promising to pay
 * doesn't change the legal arrears reality the S8 flag tracks.
 *
 * Breathing space is independent of promises — both can be active on
 * the same case simultaneously.
 */
@Injectable()
export class PromisesService {
  private readonly logger = new Logger(PromisesService.name);

  static readonly MAX_WINDOW_DAYS = 15;
  static readonly CYCLE_DAYS = 30;
  static readonly MAX_PER_CYCLE = 2;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async create(input: CreatePromiseInput): Promise<CreatePromiseResult> {
    const now = this.clock.now();
    const caseRow = await this.prisma.case.findUnique({
      where: { id: input.caseId },
      select: { id: true, status: true },
    });
    if (!caseRow) throw new NotFoundException(`Case ${input.caseId} not found`);
    if (caseRow.status !== CaseStatus.ACTIVE) {
      throw new BadRequestException(`Case ${input.caseId} is not ACTIVE`);
    }

    // 15-day forward window. Allow same-day (in case the tenant promises
    // to pay today) but reject past dates and dates > 15 days out.
    const daysOut = (input.promiseDate.getTime() - now.getTime()) / 86_400_000;
    if (daysOut < 0) {
      throw new BadRequestException('Promise date is in the past');
    }
    if (daysOut > PromisesService.MAX_WINDOW_DAYS) {
      throw new BadRequestException(
        `Promise date is more than ${PromisesService.MAX_WINDOW_DAYS} days in the future`,
      );
    }

    // R10 — one active per case, two-per-cycle.
    const existingActive = await this.prisma.promise.findFirst({
      where: { caseId: input.caseId, status: PromiseStatus.ACTIVE },
      select: { id: true },
    });
    if (existingActive) {
      throw new ConflictException(`Case ${input.caseId} already has an active promise`);
    }
    const cycleStart = new Date(now.getTime() - PromisesService.CYCLE_DAYS * 86_400_000);
    const recentCount = await this.prisma.promise.count({
      where: { caseId: input.caseId, createdAt: { gte: cycleStart } },
    });
    if (recentCount >= PromisesService.MAX_PER_CYCLE) {
      throw new ConflictException(
        `Case ${input.caseId} already has ${recentCount} promises in the last ${PromisesService.CYCLE_DAYS} days (max ${PromisesService.MAX_PER_CYCLE})`,
      );
    }

    const { promise, skipped, rejected } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.promise.create({
        data: {
          caseId: input.caseId,
          status: PromiseStatus.ACTIVE,
          promiseDate: input.promiseDate,
          createdByUserId: input.createdByUserId,
          note: input.note ?? null,
          sourceInboundCommunicationId: input.sourceInboundCommunicationId ?? null,
        },
      });

      // Pause both tracks (product choice) — pending entries get skipped
      // with reason PROMISE_ACTIVE, firedAt set so the digest ignores them.
      const skippedRes = await tx.chaseScheduleEntry.updateMany({
        where: {
          caseId: input.caseId,
          firedAt: null,
          skippedReason: null,
        },
        data: { firedAt: now, skippedReason: ChaseSkippedReason.PROMISE_ACTIVE },
      });

      // Auto-reject pending OUTBOUND **chase** drafts only (both tenant
      // and guarantor tracks). Chase drafts carry a consolidatedStage
      // (set by the digest); AI-generated reply drafts have it null and
      // are an acknowledgement — per ai-decision-spec they're supposed to
      // be sent even after the promise is logged. SENT communications
      // are also untouched.
      const rejectedRes = await tx.communication.updateMany({
        where: {
          caseId: input.caseId,
          direction: CommunicationDirection.OUTBOUND,
          consolidatedStage: { not: null },
          status: {
            in: [CommunicationStatus.AWAITING_APPROVAL, CommunicationStatus.APPROVED],
          },
        },
        data: {
          status: CommunicationStatus.AUTO_REJECTED,
          rejectedAt: now,
          rejectionReason: 'promise active',
        },
      });

      await tx.caseEvent.create({
        data: {
          caseId: input.caseId,
          kind: CaseEventKind.PROMISE_CREATED,
          occurredAt: now,
          payloadJson: {
            promiseId: created.id,
            promiseDate: created.promiseDate.toISOString(),
            note: created.note,
            chaseEntriesSkipped: skippedRes.count,
            draftsAutoRejected: rejectedRes.count,
            sourceInboundCommunicationId: created.sourceInboundCommunicationId,
          } as Prisma.InputJsonValue,
        },
      });

      return { promise: created, skipped: skippedRes.count, rejected: rejectedRes.count };
    });

    return {
      promise,
      chaseEntriesSkipped: skipped,
      draftsAutoRejected: rejected,
    };
  }

  async markFulfilled(input: ResolvePromiseInput): Promise<PromiseRow> {
    return this.resolve(input, PromiseStatus.FULFILLED, CaseEventKind.PROMISE_FULFILLED);
  }

  async cancel(input: ResolvePromiseInput): Promise<PromiseRow> {
    return this.resolve(input, PromiseStatus.CANCELLED, CaseEventKind.PROMISE_CANCELLED);
  }

  /**
   * Called by PromiseExpiryJob, not directly by handlers. Transitions
   * ACTIVE -> BROKEN and queues a broken-promise draft via the standard
   * review-queue flow (no auto-send per hard rule #2).
   */
  async markBroken(promiseId: string): Promise<PromiseRow> {
    const now = this.clock.now();
    const promise = await this.prisma.promise.findUnique({
      where: { id: promiseId },
      include: {
        case: {
          include: {
            tenancy: {
              include: { tenancyContacts: { include: { contact: true } } },
            },
            charges: true,
            organisation: { include: { config: true } },
          },
        },
      },
    });
    if (!promise) throw new NotFoundException(`Promise ${promiseId} not found`);
    if (promise.status !== PromiseStatus.ACTIVE) {
      this.logger.log(
        `promise ${promiseId} already resolved (${promise.status}); no-op markBroken`,
      );
      return promise;
    }

    const config = promise.case.organisation.config;
    const tenantContact = promise.case.tenancy.tenancyContacts.find(
      (tc) => tc.role === 'TENANT',
    )?.contact;

    await this.prisma.$transaction(async (tx) => {
      await tx.promise.update({
        where: { id: promise.id },
        data: {
          status: PromiseStatus.BROKEN,
          resolvedAt: now,
          resolvedByUserId: 'system', // expiry job; no human actor
          resolutionNote: 'Promise date passed without fulfillment',
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: promise.caseId,
          kind: CaseEventKind.PROMISE_BROKEN,
          occurredAt: now,
          payloadJson: {
            promiseId: promise.id,
            promiseDate: promise.promiseDate.toISOString(),
          } as Prisma.InputJsonValue,
        },
      });

      // Draft a broken-promise communication if we can.
      if (!config) {
        this.logger.warn(
          `promise ${promiseId} broke but case ${promise.caseId} has no org config; skipping draft`,
        );
        return;
      }
      const templateBody = config.templateBrokenPromise;
      if (!templateBody || templateBody.trim() === '') {
        this.logger.warn(
          `promise ${promiseId} broke but templateBrokenPromise is empty; skipping draft`,
        );
        return;
      }
      if (!tenantContact?.primaryEmail) {
        this.logger.warn(
          `promise ${promiseId} broke but case has no tenant primary email; skipping draft`,
        );
        return;
      }

      const overdueCharges = promise.case.charges.filter((ch) =>
        ['UNPAID', 'PARTIALLY_PAID', 'PARTIALLY_RECONCILED'].includes(ch.lastKnownStatus),
      );
      if (overdueCharges.length === 0) {
        this.logger.log(
          `promise ${promiseId} broke but no overdue charges remain on the case; skipping draft`,
        );
        return;
      }

      const balancePence = overdueCharges.reduce(
        (acc, ch) => acc + ch.lastKnownRemainAmountPence,
        0n,
      );
      const propertyAddress = [
        promise.case.tenancy.propertyName,
        promise.case.tenancy.propertyAddress1,
        promise.case.tenancy.propertyAddress2,
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
      const context: TemplateContext = {
        tenant: {
          firstName: tenantContact.firstName ?? '',
          lastName: tenantContact.lastName ?? '',
        },
        guarantor: { firstName: '', lastName: '' },
        property: { address: propertyAddress, name: promise.case.tenancy.propertyName ?? '' },
        case: {
          balanceFormatted: GBP.format(Number(balancePence) / 100),
          balancePence: Number(balancePence),
          chargeCount: overdueCharges.length,
          openedDate: DATE.format(promise.case.openedAt),
        },
        charges: chargeLines,
        mostOverdueCharge: mostOverdue,
        agency: { name: 'Lettings agency', replyEmail: 'arrears@example.com' },
      };
      let body: string;
      try {
        body = renderTemplate(templateBody, context);
      } catch (err) {
        this.logger.warn(
          `promise ${promiseId} broke but broken-promise template failed to render: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return;
      }

      const snapshot = {
        balancePence: balancePence.toString(),
        charges: overdueCharges.map((ch) => ({
          chargeId: ch.id,
          remainAmountPence: ch.lastKnownRemainAmountPence.toString(),
          status: ch.lastKnownStatus,
        })),
      };

      const comm = await tx.communication.create({
        data: {
          caseId: promise.caseId,
          organisationId: promise.case.organisationId,
          direction: CommunicationDirection.OUTBOUND,
          channel: CommunicationChannel.EMAIL,
          status: CommunicationStatus.AWAITING_APPROVAL,
          recipientRole: RecipientRole.TENANT,
          toAddress: tenantContact.primaryEmail,
          subject: 'Outstanding rent — promise not kept',
          bodyMarkdown: body,
          draftedByAi: false,
          draftSnapshotJson: snapshot as object,
          charges: { connect: overdueCharges.map((ch) => ({ id: ch.id })) },
        },
      });

      await tx.reviewQueueItem.create({
        data: {
          organisationId: promise.case.organisationId,
          caseId: promise.caseId,
          kind: ReviewItemKind.OUTBOUND_DRAFT_APPROVAL,
          communicationId: comm.id,
          priority: ReviewItemPriority.HIGH,
        },
      });

      await tx.caseEvent.create({
        data: {
          caseId: promise.caseId,
          kind: CaseEventKind.COMMUNICATION_DRAFTED,
          occurredAt: now,
          payloadJson: {
            communicationId: comm.id,
            recipientRole: RecipientRole.TENANT,
            priority: ReviewItemPriority.HIGH,
            reason: 'broken promise',
            promiseId: promise.id,
          } as Prisma.InputJsonValue,
        },
      });
    });

    const updated = await this.prisma.promise.findUniqueOrThrow({ where: { id: promiseId } });
    return updated;
  }

  private async resolve(
    input: ResolvePromiseInput,
    nextStatus: PromiseStatus,
    eventKind: CaseEventKind,
  ): Promise<PromiseRow> {
    const now = this.clock.now();
    const promise = await this.prisma.promise.findUnique({ where: { id: input.promiseId } });
    if (!promise) throw new NotFoundException(`Promise ${input.promiseId} not found`);
    if (promise.status !== PromiseStatus.ACTIVE) {
      throw new ConflictException(
        `Promise ${input.promiseId} is ${promise.status}; cannot resolve to ${nextStatus}`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.promise.update({
        where: { id: input.promiseId },
        data: {
          status: nextStatus,
          resolvedAt: now,
          resolvedByUserId: input.resolvedByUserId,
          resolutionNote: input.note ?? null,
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: promise.caseId,
          kind: eventKind,
          occurredAt: now,
          payloadJson: {
            promiseId: promise.id,
            promiseDate: promise.promiseDate.toISOString(),
            note: input.note ?? null,
          } as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
  }
}
