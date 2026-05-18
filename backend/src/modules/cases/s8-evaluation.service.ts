import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CaseEventKind,
  CaseStatus,
  EscalationFlagKind,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../integrations/prisma/prisma.service';

export type S8Transition = 'NONE' | 'RAISED' | 'RESCINDED' | 'SKIPPED';

export interface S8EvalResult {
  caseId: string;
  eligible: boolean;
  balancePence: bigint;
  thresholdPence: bigint | null;
  transition: S8Transition;
  reason?: string;
}

/**
 * Section 8 eligibility evaluator per docs/business-rules.md R6.
 *
 * Called from the LWCA invoice poll right after charges are synced — at
 * that point Charge.lastKnownRemainAmountPence is the live LWCA value, so
 * the R5.1 "re-sync before threshold check" requirement is already met.
 * If we add other callers later (partial-payment hook, manual recompute),
 * they must re-sync first.
 *
 * R6.1 — eligible when balance >= min(rent × monthsThreshold, rent × weeksThreshold / 4)
 * R6.2 — FALSE→TRUE: raise EscalationFlag(S8_ELIGIBLE), set s8Eligible=true, emit S8_ELIGIBILITY_RAISED
 * R6.3 — TRUE→FALSE: resolve flag, set s8Eligible=false, emit S8_ELIGIBILITY_RESCINDED
 * R6.4 — yo-yo: re-raised on next transition; only current state tracked
 * R6.5 — informational only (no S8 paperwork is generated/sent)
 * R6.6 — breathing space active suppresses eligibility entirely
 */
@Injectable()
export class S8EvaluationService {
  private readonly logger = new Logger(S8EvaluationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async evaluate(caseId: string): Promise<S8EvalResult> {
    return this.prisma.$transaction(async (tx) => {
      const caseRow = await tx.case.findUnique({
        where: { id: caseId },
        include: {
          tenancy: { select: { rentAmountPence: true } },
          charges: { select: { lastKnownRemainAmountPence: true } },
        },
      });
      if (!caseRow) throw new NotFoundException(`Case ${caseId} not found`);

      if (caseRow.status !== CaseStatus.ACTIVE) {
        return skipped(caseId, caseRow.s8Eligible, 'case not ACTIVE');
      }

      const config = await tx.organisationConfig.findUnique({
        where: { organisationId: caseRow.organisationId },
      });
      if (!config) {
        return skipped(caseId, caseRow.s8Eligible, 'no organisation config');
      }

      const balance = caseRow.charges.reduce(
        (acc, c) => acc + c.lastKnownRemainAmountPence,
        0n,
      );

      const rent = caseRow.tenancy.rentAmountPence;
      const threshold =
        rent == null
          ? null
          : computeThreshold(rent, config.s8RentMonthsThreshold, config.s8WeeksThreshold);

      // R6.6: breathing space suppresses S8 regardless of balance.
      const newEligible =
        caseRow.breathingSpaceActive || threshold == null
          ? false
          : balance >= threshold;

      if (newEligible === caseRow.s8Eligible) {
        return {
          caseId,
          eligible: newEligible,
          balancePence: balance,
          thresholdPence: threshold,
          transition: 'NONE',
        };
      }

      const now = new Date();
      if (newEligible) {
        // R6.2 — FALSE → TRUE
        const reason = `balance ${balance}p meets threshold ${threshold}p`;
        await tx.case.update({
          where: { id: caseId },
          data: { s8Eligible: true },
        });
        await tx.escalationFlag.create({
          data: {
            caseId,
            kind: EscalationFlagKind.S8_ELIGIBLE,
            raisedAt: now,
            raisedReason: reason,
            payloadJson: {
              balancePence: balance.toString(),
              thresholdPence: threshold!.toString(),
            } as Prisma.InputJsonValue,
          },
        });
        await tx.caseEvent.create({
          data: {
            caseId,
            kind: CaseEventKind.S8_ELIGIBILITY_RAISED,
            occurredAt: now,
            payloadJson: {
              balancePence: balance.toString(),
              thresholdPence: threshold!.toString(),
            } as Prisma.InputJsonValue,
          },
        });
        return {
          caseId,
          eligible: true,
          balancePence: balance,
          thresholdPence: threshold,
          transition: 'RAISED',
          reason,
        };
      }

      // R6.3 — TRUE → FALSE
      const reason = caseRow.breathingSpaceActive
        ? 'breathing space active'
        : threshold == null
          ? 'rent unknown'
          : `balance ${balance}p below threshold ${threshold}p`;
      await tx.case.update({
        where: { id: caseId },
        data: { s8Eligible: false },
      });
      await tx.escalationFlag.updateMany({
        where: {
          caseId,
          kind: EscalationFlagKind.S8_ELIGIBLE,
          resolvedAt: null,
        },
        data: { resolvedAt: now, resolvedReason: reason },
      });
      await tx.caseEvent.create({
        data: {
          caseId,
          kind: CaseEventKind.S8_ELIGIBILITY_RESCINDED,
          occurredAt: now,
          payloadJson: {
            balancePence: balance.toString(),
            thresholdPence: threshold == null ? null : threshold.toString(),
            reason,
          } as Prisma.InputJsonValue,
        },
      });
      return {
        caseId,
        eligible: false,
        balancePence: balance,
        thresholdPence: threshold,
        transition: 'RESCINDED',
        reason,
      };
    });
  }
}

function computeThreshold(
  rentPence: bigint,
  monthsThreshold: number,
  weeksThreshold: number,
): bigint {
  const months = rentPence * BigInt(monthsThreshold);
  // Spec formula: rent × weeks / 4 — assumes rentAmountPence is monthly.
  const weeks = (rentPence * BigInt(weeksThreshold)) / 4n;
  return months < weeks ? months : weeks;
}

function skipped(caseId: string, currentEligible: boolean, reason: string): S8EvalResult {
  return {
    caseId,
    eligible: currentEligible,
    balancePence: 0n,
    thresholdPence: null,
    transition: 'SKIPPED',
    reason,
  };
}
