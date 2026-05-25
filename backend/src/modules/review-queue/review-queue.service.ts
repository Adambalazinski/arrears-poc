import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CaseEventKind,
  CommunicationDirection,
  CommunicationStatus,
  ReviewItemKind,
  ReviewItemResolution,
  type ClassificationResult,
  type Communication,
} from '@prisma/client';
import {
  OUTLOOK_CLIENT,
  OutboundSendError,
  type OutboundMailer,
} from '../../integrations/outlook/outlook.types';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import { LwcaInvoicePollJob } from '../cases/jobs/lwca-invoice-poll.job';
import type { DraftSnapshot } from '../chase/digest/digest.service';

const BALANCE_TOLERANCE_PENCE = 1n; // R9.2 rounding-safe threshold

const ZERO_CONTRIBUTION_STATUSES: ReadonlySet<string> = new Set([
  'PAID',
  'RECONCILED',
  'DELETED',
]);

export interface BalanceChangedDetail {
  draftBalancePence: string;
  currentBalancePence: string;
  perCharge: Array<{
    chargeId: string;
    draftRemainPence: string;
    currentRemainPence: string;
    draftStatus: string;
    currentStatus: string;
    changed: boolean;
  }>;
}

export class BalanceChangedError extends ConflictException {
  constructor(public readonly detail: BalanceChangedDetail) {
    super({ code: 'BALANCE_CHANGED', detail });
  }
}

export interface ListedReviewQueueItem {
  id: string;
  organisationId: string;
  caseId: string;
  kind: ReviewItemKind;
  priority: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
  /** True when a ClassificationResult is linked — flag for the "AI" chip in the list. */
  hasAiRationale: boolean;
  communication: Pick<
    Communication,
    | 'id'
    | 'direction'
    | 'recipientRole'
    | 'subject'
    | 'consolidatedStage'
    | 'toAddress'
    | 'fromAddress'
    | 'bodyMarkdown'
    | 'createdAt'
  > | null;
}

export type DetailClassification = Pick<
  ClassificationResult,
  | 'id'
  | 'preFilterMatched'
  | 'preFilterTriggerKind'
  | 'preFilterMatchedKeyword'
  | 'modelUsed'
  | 'sentiment'
  | 'intent'
  | 'rationale'
  | 'promptTokens'
  | 'completionTokens'
  | 'estimatedCostPence'
> & {
  /** Stringified Decimal so JSON serialises cleanly. */
  confidence: string | null;
};

/**
 * Per docs/business-rules.md R9 (balance-changed-since-draft).
 *
 *   - approve(): re-syncs the org from LWCA so we're comparing against
 *     the truest known state of every linked charge (R9.1), then compares
 *     each charge's current `lastKnownRemainAmountPence` and
 *     `lastKnownStatus` to the snapshot taken at draft time. Any per-charge
 *     remain delta > 1p, OR a status that moved into {PAID, RECONCILED,
 *     DELETED}, triggers BalanceChangedError(409) with the per-charge
 *     diff so the UI can render a "regenerate" prompt.
 *   - approve() does NOT yet send via Outlook — Phase 6.2 wires that.
 *     The Communication's `status` flips to APPROVED, the ReviewQueueItem
 *     resolves with `APPROVED_AND_SENT`, and a COMMUNICATION_APPROVED
 *     CaseEvent is emitted.
 *   - reject(): marks the Communication REJECTED, resolves the queue item
 *     with `REJECTED`, emits COMMUNICATION_REJECTED.
 *   - edit-then-approve: pass `editedBodyMarkdown` to approve(); the new
 *     body is persisted before the balance check.
 */
@Injectable()
export class ReviewQueueService {
  private readonly logger = new Logger(ReviewQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly poll: LwcaInvoicePollJob,
    @Inject(OUTLOOK_CLIENT) private readonly mailer: OutboundMailer,
  ) {}

  async list(organisationId: string): Promise<ListedReviewQueueItem[]> {
    const rows = await this.prisma.reviewQueueItem.findMany({
      where: { organisationId, resolvedAt: null },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      include: {
        communication: {
          select: {
            id: true,
            direction: true,
            recipientRole: true,
            subject: true,
            consolidatedStage: true,
            toAddress: true,
            fromAddress: true,
            bodyMarkdown: true,
            createdAt: true,
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      organisationId: r.organisationId,
      caseId: r.caseId,
      kind: r.kind,
      priority: r.priority,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      resolution: r.resolution,
      hasAiRationale: r.classificationResultId !== null,
      communication: r.communication,
    }));
  }

  async get(id: string) {
    const found = await this.prisma.reviewQueueItem.findUnique({
      where: { id },
      include: {
        communication: {
          include: { charges: true },
        },
      },
    });
    if (!found) throw new NotFoundException(`ReviewQueueItem ${id} not found`);

    // Pull the linked classification (if any) and the matching inbound
    // body for inbound items so the UI can render the rationale panel
    // and the original message side-by-side with the draft.
    const classification: DetailClassification | null = found.classificationResultId
      ? await this.fetchClassification(found.classificationResultId)
      : null;

    let inbound: Pick<
      Communication,
      'id' | 'subject' | 'fromAddress' | 'rawBodyText' | 'receivedAt'
    > | null = null;
    if (
      found.communication?.direction === CommunicationDirection.INBOUND
    ) {
      inbound = {
        id: found.communication.id,
        subject: found.communication.subject,
        fromAddress: found.communication.fromAddress,
        rawBodyText: (found.communication as { rawBodyText: string | null }).rawBodyText,
        receivedAt: (found.communication as { receivedAt: Date | null }).receivedAt,
      };
    } else if (classification?.id) {
      // OUTBOUND AI draft: the classification points back at the
      // inbound via its communicationId column. Look it up so the
      // reviewer can read what the tenant wrote before approving the
      // auto-drafted reply.
      const cr = await this.prisma.classificationResult.findUnique({
        where: { id: classification.id },
        select: { communicationId: true },
      });
      if (cr) {
        inbound = await this.prisma.communication.findUnique({
          where: { id: cr.communicationId },
          select: {
            id: true,
            subject: true,
            fromAddress: true,
            rawBodyText: true,
            receivedAt: true,
          },
        });
      }
    }

    return {
      ...found,
      classification,
      inbound,
    };
  }

  private async fetchClassification(
    classificationResultId: string,
  ): Promise<DetailClassification | null> {
    const row = await this.prisma.classificationResult.findUnique({
      where: { id: classificationResultId },
    });
    if (!row) return null;
    return {
      id: row.id,
      preFilterMatched: row.preFilterMatched,
      preFilterTriggerKind: row.preFilterTriggerKind,
      preFilterMatchedKeyword: row.preFilterMatchedKeyword,
      modelUsed: row.modelUsed,
      sentiment: row.sentiment,
      intent: row.intent,
      confidence: row.confidence === null ? null : row.confidence.toString(),
      rationale: row.rationale,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      estimatedCostPence: row.estimatedCostPence,
    };
  }

  async approve(itemId: string, actorUserId: string, editedBodyMarkdown?: string) {
    const item = await this.get(itemId);
    if (item.resolvedAt) {
      throw new ConflictException(`ReviewQueueItem ${itemId} already resolved`);
    }
    if (item.kind !== 'OUTBOUND_DRAFT_APPROVAL') {
      throw new ConflictException(
        `ReviewQueueItem ${itemId} is ${item.kind}, not an outbound draft`,
      );
    }
    if (!item.communication) {
      throw new ConflictException(`ReviewQueueItem ${itemId} has no linked Communication`);
    }
    // SEND_FAILED is retry-able: the draft is already approved-and-sent
    // in intent, just the outbound call failed. Re-running approve will
    // re-attempt the send. Anything else (SENT, REJECTED, etc.) means
    // the comm is in a terminal state and can't be re-approved.
    const retryableStatuses = ['AWAITING_APPROVAL', 'SEND_FAILED'];
    if (!retryableStatuses.includes(item.communication.status)) {
      throw new ConflictException(
        `Communication ${item.communication.id} is ${item.communication.status}; cannot approve`,
      );
    }

    // R9.1: re-fetch all linked charges from LWCA. We re-poll the org
    // rather than each charge individually because the polling path is
    // the one that's been hardened in 4.3.
    try {
      await this.poll.runForOrg(item.organisationId);
    } catch (err) {
      this.logger.warn(
        `review-queue: pre-approve LWCA re-sync for org ${item.organisationId} failed — ${err instanceof Error ? err.message : err}; falling back to last-known balances`,
      );
    }

    // Reload charges after the re-sync.
    const freshCharges = await this.prisma.charge.findMany({
      where: { id: { in: item.communication.charges.map((ch) => ch.id) } },
    });
    const snapshot = item.communication.draftSnapshotJson as unknown as DraftSnapshot | null;
    if (!snapshot) {
      throw new ConflictException(
        `Communication ${item.communication.id} has no draft snapshot; cannot run R9 check`,
      );
    }

    const diff = computeBalanceDiff(snapshot, freshCharges);
    if (diff) {
      throw new BalanceChangedError(diff);
    }

    // Approve. Phase 6.2: persist the approval, attempt the send, and
    // then either flip Communication -> SENT (resolution APPROVED_AND_SENT /
    // EDITED_AND_SENT) or -> SEND_FAILED with the error stored on
    // sendErrorJson. The ReviewQueueItem stays pending on send failure so
    // the reviewer can retry once the upstream is back.
    const now = new Date();
    const communicationId = item.communication.id;
    const finalSubject = item.communication.subject ?? '(no subject)';
    const finalBody = editedBodyMarkdown ?? item.communication.bodyMarkdown ?? '';
    const finalToAddress = item.communication.toAddress;
    if (!finalToAddress) {
      throw new ConflictException(
        `Communication ${communicationId} has no toAddress; cannot send`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.communication.update({
        where: { id: communicationId },
        data: {
          status: CommunicationStatus.APPROVED,
          approvedAt: now,
          approvedByUserId: actorUserId,
          ...(editedBodyMarkdown !== undefined ? { bodyMarkdown: editedBodyMarkdown } : {}),
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: item.caseId,
          kind: CaseEventKind.COMMUNICATION_APPROVED,
          actorUserId,
          payloadJson: {
            reviewQueueItemId: itemId,
            communicationId,
            edited: editedBodyMarkdown !== undefined,
          },
          occurredAt: now,
        },
      });
    });

    let send: Awaited<ReturnType<OutboundMailer['sendMail']>>;
    try {
      send = await this.mailer.sendMail({
        toAddress: finalToAddress,
        subject: finalSubject,
        bodyMarkdown: finalBody,
      });
    } catch (err) {
      const errorPayload =
        err instanceof OutboundSendError
          ? { name: err.name, message: err.message }
          : { name: err instanceof Error ? err.name : 'Error', message: String(err) };
      await this.prisma.communication.update({
        where: { id: communicationId },
        data: {
          status: CommunicationStatus.SEND_FAILED,
          sendErrorJson: errorPayload,
        },
      });
      this.logger.error(
        `review-queue: send failed for communication ${communicationId} — ${errorPayload.message}`,
      );
      throw err;
    }

    const sentAt = send.acceptedAt;
    await this.prisma.$transaction(async (tx) => {
      await tx.communication.update({
        where: { id: communicationId },
        data: {
          status: CommunicationStatus.SENT,
          sentAt,
          outlookSentMessageId: send.messageId,
        },
      });
      await tx.reviewQueueItem.update({
        where: { id: itemId },
        data: {
          resolvedAt: sentAt,
          resolvedByUserId: actorUserId,
          resolution:
            editedBodyMarkdown !== undefined ? 'EDITED_AND_SENT' : 'APPROVED_AND_SENT',
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: item.caseId,
          kind: CaseEventKind.COMMUNICATION_SENT,
          actorUserId,
          payloadJson: {
            reviewQueueItemId: itemId,
            communicationId,
            outlookSentMessageId: send.messageId,
          },
          occurredAt: sentAt,
        },
      });
    });
    return { ok: true as const, messageId: send.messageId };
  }

  async reject(itemId: string, actorUserId: string, reason: string) {
    const item = await this.get(itemId);
    if (item.resolvedAt) {
      throw new ConflictException(`ReviewQueueItem ${itemId} already resolved`);
    }
    if (item.kind !== ReviewItemKind.OUTBOUND_DRAFT_APPROVAL) {
      throw new ConflictException(
        `ReviewQueueItem ${itemId} is ${item.kind}; use dismiss for inbound items`,
      );
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (item.communication) {
        await tx.communication.update({
          where: { id: item.communication.id },
          data: {
            status: CommunicationStatus.REJECTED,
            rejectedAt: now,
            rejectedByUserId: actorUserId,
            rejectionReason: reason,
          },
        });
      }
      await tx.reviewQueueItem.update({
        where: { id: itemId },
        data: {
          resolvedAt: now,
          resolvedByUserId: actorUserId,
          resolution: ReviewItemResolution.REJECTED,
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: item.caseId,
          kind: CaseEventKind.COMMUNICATION_REJECTED,
          actorUserId,
          payloadJson: {
            reviewQueueItemId: itemId,
            communicationId: item.communication?.id ?? null,
            reason,
          },
          occurredAt: now,
        },
      });
    });
    return { ok: true as const };
  }

  /**
   * Inbound-only action. INBOUND_LOW_CONFIDENCE and HARD_TRIGGER_ESCALATION
   * items aren't drafts to send — they're inbound messages the handler
   * has actioned outside the system (phone call, in-person, manual
   * email, etc.). Dismiss resolves the queue item without mutating the
   * underlying Communication (which is already PROCESSED).
   */
  async dismiss(itemId: string, actorUserId: string, note?: string) {
    const item = await this.get(itemId);
    if (item.resolvedAt) {
      throw new ConflictException(`ReviewQueueItem ${itemId} already resolved`);
    }
    if (
      item.kind !== ReviewItemKind.INBOUND_LOW_CONFIDENCE &&
      item.kind !== ReviewItemKind.HARD_TRIGGER_ESCALATION
    ) {
      throw new ConflictException(
        `ReviewQueueItem ${itemId} is ${item.kind}; dismiss only applies to inbound items`,
      );
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.reviewQueueItem.update({
        where: { id: itemId },
        data: {
          resolvedAt: now,
          resolvedByUserId: actorUserId,
          resolution: ReviewItemResolution.HANDLER_ACTIONED,
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: item.caseId,
          kind: CaseEventKind.HANDLER_ASSIGNED,
          actorUserId,
          payloadJson: {
            reviewQueueItemId: itemId,
            kind: item.kind,
            communicationId: item.communication?.id ?? null,
            note: note ?? null,
            action: 'dismissed',
          },
          occurredAt: now,
        },
      });
    });
    return { ok: true as const };
  }
}

function computeBalanceDiff(
  snapshot: DraftSnapshot,
  freshCharges: Array<{ id: string; lastKnownRemainAmountPence: bigint; lastKnownStatus: string }>,
): BalanceChangedDetail | null {
  const byId = new Map(snapshot.charges.map((c) => [c.chargeId, c] as const));
  const perCharge: BalanceChangedDetail['perCharge'] = [];
  let changedAny = false;

  for (const fresh of freshCharges) {
    const snap = byId.get(fresh.id);
    const draftRemain = snap ? BigInt(snap.remainAmountPence) : 0n;
    const draftStatus = snap?.status ?? 'UNKNOWN';
    const currentRemain = fresh.lastKnownRemainAmountPence;
    const remainDelta = absBigInt(currentRemain - draftRemain);
    const statusChangedToZero =
      ZERO_CONTRIBUTION_STATUSES.has(fresh.lastKnownStatus) &&
      !ZERO_CONTRIBUTION_STATUSES.has(draftStatus);
    const changed = remainDelta > BALANCE_TOLERANCE_PENCE || statusChangedToZero;
    if (changed) changedAny = true;
    perCharge.push({
      chargeId: fresh.id,
      draftRemainPence: draftRemain.toString(),
      currentRemainPence: currentRemain.toString(),
      draftStatus,
      currentStatus: fresh.lastKnownStatus,
      changed,
    });
  }

  if (!changedAny) return null;
  return {
    draftBalancePence: snapshot.balancePence,
    currentBalancePence: freshCharges
      .reduce((acc, c) => acc + c.lastKnownRemainAmountPence, 0n)
      .toString(),
    perCharge,
  };
}

function absBigInt(n: bigint): bigint {
  return n < 0n ? -n : n;
}
