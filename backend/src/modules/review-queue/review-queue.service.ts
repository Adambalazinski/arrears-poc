import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CaseEventKind,
  CommunicationStatus,
  type Communication,
  type ReviewItemKind,
} from '@prisma/client';
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
  communication: Pick<
    Communication,
    'id' | 'subject' | 'consolidatedStage' | 'toAddress' | 'bodyMarkdown' | 'createdAt'
  > | null;
}

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
  ) {}

  list(organisationId: string): Promise<ListedReviewQueueItem[]> {
    return this.prisma.reviewQueueItem.findMany({
      where: { organisationId, resolvedAt: null },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      include: {
        communication: {
          select: {
            id: true,
            subject: true,
            consolidatedStage: true,
            toAddress: true,
            bodyMarkdown: true,
            createdAt: true,
          },
        },
      },
    });
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
    return found;
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
    if (item.communication.status !== 'AWAITING_APPROVAL') {
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

    // Approve.
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.communication.update({
        where: { id: item.communication!.id },
        data: {
          status: CommunicationStatus.APPROVED,
          approvedAt: now,
          approvedByUserId: actorUserId,
          ...(editedBodyMarkdown !== undefined ? { bodyMarkdown: editedBodyMarkdown } : {}),
        },
      });
      await tx.reviewQueueItem.update({
        where: { id: itemId },
        data: {
          resolvedAt: now,
          resolvedByUserId: actorUserId,
          // Phase 6.2 will flip to APPROVED_AND_SENT after a successful
          // send. Until then "approved" leaves the queue and is recorded.
          resolution: 'APPROVED_AND_SENT',
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: item.caseId,
          kind: CaseEventKind.COMMUNICATION_APPROVED,
          actorUserId,
          payloadJson: {
            reviewQueueItemId: itemId,
            communicationId: item.communication!.id,
            edited: editedBodyMarkdown !== undefined,
          },
          occurredAt: now,
        },
      });
    });
    return { ok: true as const };
  }

  async reject(itemId: string, actorUserId: string, reason: string) {
    const item = await this.get(itemId);
    if (item.resolvedAt) {
      throw new ConflictException(`ReviewQueueItem ${itemId} already resolved`);
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
          resolution: 'REJECTED',
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
