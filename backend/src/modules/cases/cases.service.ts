import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CaseEventKind,
  CaseStatus,
  type ChargeStatus,
  CommunicationStatus,
  Prisma,
  type Case,
  type Charge,
} from '@prisma/client';
import { PrismaService } from '../../integrations/prisma/prisma.service';

const FINAL_CHARGE_STATUSES: ReadonlySet<ChargeStatus> = new Set([
  'PAID',
  'RECONCILED',
  'DELETED',
]);

export interface OpenOrAttachResult {
  caseId: string;
  opened: boolean;
}

export interface RecomputeResult {
  closed: boolean;
  balancePence: bigint;
  chargeCount: number;
}

/**
 * Case lifecycle per docs/business-rules.md R1 (open) + R2 (close).
 *
 * Invariants this service preserves (verified at the partial-unique-index
 * level in Postgres — see backend/src/prisma/migrations/.../partial_indexes):
 *   - exactly one ACTIVE case per (tenancyId)
 *   - lastKnownBalancePence on Case == sum of remain on its charges
 *   - status=CLOSED iff every charge is in {PAID, RECONCILED, DELETED}
 *     AND balance is 0.
 */
@Injectable()
export class CasesService {
  private readonly logger = new Logger(CasesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** R1.2 helper: returns the active case for a tenancy if one exists. */
  findActive(organisationId: string, tenancyId: string): Promise<Case | null> {
    return this.prisma.case.findFirst({
      where: { organisationId, tenancyId, status: CaseStatus.ACTIVE },
    });
  }

  /**
   * R1.1 / R1.2: if an active case exists for the tenancy, return it;
   * otherwise open a new one. Charges aren't created here — that's the
   * charges module — but the polling caller is expected to upsert the
   * charge against the returned caseId in the same overall flow.
   */
  async openOrAttach(
    organisationId: string,
    tenancyId: string,
  ): Promise<OpenOrAttachResult> {
    const existing = await this.findActive(organisationId, tenancyId);
    if (existing) return { caseId: existing.id, opened: false };

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const created = await tx.case.create({
          data: {
            organisationId,
            tenancyId,
            status: CaseStatus.ACTIVE,
            openedAt: now,
            lastKnownBalancePence: 0n,
            lastKnownBalanceAt: now,
          },
        });
        await tx.caseEvent.create({
          data: {
            caseId: created.id,
            kind: CaseEventKind.CASE_OPENED,
            payloadJson: { organisationId, tenancyId },
          },
        });
        return { caseId: created.id, opened: true };
      });
      return result;
    } catch (err) {
      // The partial unique index on case(tenancyId) WHERE status='ACTIVE'
      // catches a race where two parallel openOrAttach for the same
      // tenancy slip past the findActive check. Recover by reading
      // the case the other writer just created.
      if (isUniqueViolation(err)) {
        const race = await this.findActive(organisationId, tenancyId);
        if (race) return { caseId: race.id, opened: false };
      }
      throw err;
    }
  }

  /**
   * R5: sum of charge.remain. Live computation, not cached. Callers that
   * mutate charges should call this and update Case.lastKnownBalancePence in
   * the same transaction — recomputeAndMaybeClose does both.
   */
  async recomputeBalance(caseId: string): Promise<bigint> {
    const agg = await this.prisma.charge.aggregate({
      where: { caseId },
      _sum: { lastKnownRemainAmountPence: true },
    });
    return agg._sum.lastKnownRemainAmountPence ?? 0n;
  }

  /**
   * R2.1: close the case iff every charge is in a final state AND balance
   * is zero. Always updates Case.lastKnownBalancePence regardless of
   * close decision. R2.2 side effects (skip pending chase entries,
   * auto-reject pending drafts) are applied here so they live with the
   * lifecycle transition.
   */
  async recomputeAndMaybeClose(caseId: string): Promise<RecomputeResult> {
    return this.prisma.$transaction(async (tx) => {
      const [existing, charges] = await Promise.all([
        tx.case.findUnique({ where: { id: caseId } }),
        tx.charge.findMany({ where: { caseId } }),
      ]);
      if (!existing) throw new NotFoundException(`Case ${caseId} not found`);

      const balance = sumBalance(charges);
      const shouldClose = canClose(charges, balance) && existing.status === CaseStatus.ACTIVE;
      const now = new Date();

      await tx.case.update({
        where: { id: caseId },
        data: {
          lastKnownBalancePence: balance,
          lastKnownBalanceAt: now,
          ...(shouldClose ? { status: CaseStatus.CLOSED, closedAt: now } : {}),
        },
      });

      if (shouldClose) {
        await tx.caseEvent.create({
          data: {
            caseId,
            kind: CaseEventKind.CASE_CLOSED,
            payloadJson: {
              balancePence: balance.toString(),
              chargeCount: charges.length,
            },
          },
        });

        // R2.2: pending chase entries -> skipped(CASE_CLOSED)
        await tx.chaseScheduleEntry.updateMany({
          where: { caseId, firedAt: null, skippedReason: null },
          data: { skippedReason: 'CASE_CLOSED', firedAt: now },
        });

        // R2.2: pending outbound drafts auto-rejected
        await tx.communication.updateMany({
          where: {
            caseId,
            direction: 'OUTBOUND',
            status: CommunicationStatus.AWAITING_APPROVAL,
          },
          data: {
            status: CommunicationStatus.AUTO_REJECTED,
            rejectedAt: now,
            rejectionReason: 'case closed',
          },
        });

        // Pending review queue items -> resolved DISMISSED
        await tx.reviewQueueItem.updateMany({
          where: { caseId, resolvedAt: null },
          data: { resolvedAt: now, resolution: 'DISMISSED' },
        });
      }

      return {
        closed: shouldClose,
        balancePence: balance,
        chargeCount: charges.length,
      };
    });
  }

  async list(organisationId: string, status?: CaseStatus) {
    const cases = await this.prisma.case.findMany({
      where: { organisationId, ...(status ? { status } : {}) },
      orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
      include: {
        tenancy: {
          include: {
            // Only TENANT-role contacts surface in the cases-list "Tenant"
            // column; guarantors are visible on the case detail page.
            tenancyContacts: {
              where: { role: 'TENANT' },
              include: {
                contact: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    companyName: true,
                  },
                },
              },
            },
          },
        },
        charges: {
          select: {
            id: true,
            lwcaInvoiceId: true,
            currentStage: true,
            workingDaysOverdue: true,
            lastKnownStatus: true,
            lastKnownRemainAmountPence: true,
            grossAmountPence: true,
            dueDate: true,
            lastSyncedAt: true,
          },
        },
      },
    });

    // Derived "last actor": the most recent CaseEvent on each case with
    // a non-null actorUserId. Used as a fallback for the cases-list
    // Handler column when handlerUserId is unset.
    const caseIds = cases.map((c) => c.id);
    const recentActors =
      caseIds.length === 0
        ? []
        : await this.prisma.caseEvent.findMany({
            where: { caseId: { in: caseIds }, actorUserId: { not: null } },
            orderBy: { occurredAt: 'desc' },
            distinct: ['caseId'],
            select: { caseId: true, actorUserId: true, occurredAt: true },
          });
    const lastActorByCase = new Map(
      recentActors.map((e) => [
        e.caseId,
        { userId: e.actorUserId, at: e.occurredAt },
      ]),
    );

    return cases.map((c) => ({
      ...c,
      lastActorUserId: lastActorByCase.get(c.id)?.userId ?? null,
      lastActorAt: lastActorByCase.get(c.id)?.at ?? null,
    }));
  }

  async getDetail(caseId: string) {
    const found = await this.prisma.case.findUnique({
      where: { id: caseId },
      include: {
        tenancy: {
          include: {
            tenancyContacts: { include: { contact: true } },
          },
        },
        charges: { orderBy: { dueDate: 'asc' } },
        events: { orderBy: { occurredAt: 'asc' }, take: 200 },
        escalationFlags: {
          where: { resolvedAt: null },
          orderBy: { raisedAt: 'asc' },
        },
        promises: { orderBy: { createdAt: 'desc' }, take: 20 },
        communications: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            direction: true,
            channel: true,
            status: true,
            recipientRole: true,
            consolidatedStage: true,
            toAddress: true,
            fromAddress: true,
            subject: true,
            bodyMarkdown: true,
            rawBodyText: true,
            receivedAt: true,
            sentAt: true,
            approvedAt: true,
            rejectedAt: true,
            rejectionReason: true,
            createdAt: true,
            draftedByAi: true,
          },
        },
      },
    });
    if (!found) throw new NotFoundException(`Case ${caseId} not found`);

    const lastActor = await this.prisma.caseEvent.findFirst({
      where: { caseId, actorUserId: { not: null } },
      orderBy: { occurredAt: 'desc' },
      select: { actorUserId: true, occurredAt: true },
    });

    return {
      ...found,
      lastActorUserId: lastActor?.actorUserId ?? null,
      lastActorAt: lastActor?.occurredAt ?? null,
    };
  }

  /**
   * Assign or unassign the case handler. Pass `null` to clear. Emits a
   * HANDLER_ASSIGNED case event with the actor recorded in
   * `actorUserId` and the new handler id in the payload so the
   * timeline shows who did what.
   */
  async setHandler(input: {
    caseId: string;
    handlerUserId: string | null;
    actorUserId: string;
  }): Promise<{ caseId: string; handlerUserId: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.case.findUnique({
        where: { id: input.caseId },
        select: { id: true, handlerUserId: true },
      });
      if (!existing) throw new NotFoundException(`Case ${input.caseId} not found`);
      if (existing.handlerUserId === input.handlerUserId) {
        return { caseId: existing.id, handlerUserId: existing.handlerUserId };
      }
      const updated = await tx.case.update({
        where: { id: input.caseId },
        data: { handlerUserId: input.handlerUserId },
        select: { id: true, handlerUserId: true },
      });
      await tx.caseEvent.create({
        data: {
          caseId: input.caseId,
          kind: CaseEventKind.HANDLER_ASSIGNED,
          actorUserId: input.actorUserId,
          payloadJson: {
            previousHandlerUserId: existing.handlerUserId,
            handlerUserId: input.handlerUserId,
          },
        },
      });
      return { caseId: updated.id, handlerUserId: updated.handlerUserId };
    });
  }
}

function sumBalance(charges: Pick<Charge, 'lastKnownRemainAmountPence'>[]): bigint {
  return charges.reduce((acc, c) => acc + c.lastKnownRemainAmountPence, 0n);
}

function canClose(charges: Pick<Charge, 'lastKnownStatus'>[], balance: bigint): boolean {
  if (charges.length === 0) return false; // never close a case that never had charges
  if (balance !== 0n) return false;
  return charges.every((c) => FINAL_CHARGE_STATUSES.has(c.lastKnownStatus));
}

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === 'P2002';
  // The raw-SQL partial unique index from migration 20260514080823_partial_indexes
  // is enforced by Postgres but Prisma reports it as P2010 / P2034 depending
  // on the path. Match by SQLSTATE 23505 (unique_violation) where present.
  if (
    typeof err === 'object' &&
    err !== null &&
    'meta' in err &&
    typeof (err as { meta?: { code?: string } }).meta?.code === 'string' &&
    (err as { meta: { code: string } }).meta.code === '23505'
  ) {
    return true;
  }
  return false;
}
