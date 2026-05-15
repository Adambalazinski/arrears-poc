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

  list(organisationId: string, status?: CaseStatus) {
    return this.prisma.case.findMany({
      where: { organisationId, ...(status ? { status } : {}) },
      orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
      include: {
        tenancy: true,
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
      },
    });
    if (!found) throw new NotFoundException(`Case ${caseId} not found`);
    return found;
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
