import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CaseEventKind,
  CaseStatus,
  ChaseSkippedReason,
  CommunicationStatus,
  EscalationFlagKind,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import { S8EvaluationService } from './s8-evaluation.service';

export type BreathingSpaceSource = 'FORMAL_NOTIFICATION' | 'TENANT_EMAIL_MENTION';

export interface ActivateInput {
  caseId: string;
  source: BreathingSpaceSource;
  note?: string;
}

export interface DeactivateInput {
  caseId: string;
  note?: string;
}

export interface ToggleResult {
  caseId: string;
  breathingSpaceActive: boolean;
  changed: boolean;
  chaseEntriesSkipped: number;
  draftsAutoRejected: number;
}

/**
 * Breathing space lifecycle per docs/business-rules.md R7.
 *
 * Activation (R7.1, R7.2):
 *   - Case.breathingSpaceActive = true
 *   - Pending ChaseScheduleEntry rows (firedAt IS NULL, skippedReason IS NULL)
 *     are marked skipped with reason BREATHING_SPACE_ACTIVE
 *   - Pending OUTBOUND Communications (status in AWAITING_APPROVAL or APPROVED)
 *     are auto-rejected with reason "breathing space active"
 *   - EscalationFlag(BREATHING_SPACE) is raised
 *   - S8EvaluationService.evaluate is called — R6.6 forces s8Eligible=false and
 *     resolves any open S8_ELIGIBLE flag
 *   - CaseEvent BREATHING_SPACE_ACTIVATED is emitted with source + note in the
 *     payload
 *
 * Deactivation (R7.3):
 *   - Case.breathingSpaceActive = false
 *   - BREATHING_SPACE EscalationFlag is resolved
 *   - S8 is re-evaluated (may re-raise the flag if balance is still over
 *     threshold)
 *   - CaseEvent BREATHING_SPACE_DEACTIVATED emitted
 *   - Past skipped chase entries stay skipped per R7.3 — cadence resumes from
 *     the next tick
 *
 * Idempotent: a second activate (or deactivate) is a no-op (changed=false).
 * Closed cases reject both operations.
 */
@Injectable()
export class BreathingSpaceService {
  private readonly logger = new Logger(BreathingSpaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s8: S8EvaluationService,
  ) {}

  async activate(input: ActivateInput): Promise<ToggleResult> {
    const caseRow = await this.assertActiveCase(input.caseId);
    if (caseRow.breathingSpaceActive) {
      return {
        caseId: input.caseId,
        breathingSpaceActive: true,
        changed: false,
        chaseEntriesSkipped: 0,
        draftsAutoRejected: 0,
      };
    }

    const cascades = await this.prisma.$transaction(async (tx) => {
      const now = new Date();

      await tx.case.update({
        where: { id: input.caseId },
        data: { breathingSpaceActive: true },
      });

      const skipped = await tx.chaseScheduleEntry.updateMany({
        where: {
          caseId: input.caseId,
          firedAt: null,
          skippedReason: null,
        },
        data: {
          skippedReason: ChaseSkippedReason.BREATHING_SPACE_ACTIVE,
          firedAt: now,
        },
      });

      const rejected = await tx.communication.updateMany({
        where: {
          caseId: input.caseId,
          direction: 'OUTBOUND',
          status: {
            in: [CommunicationStatus.AWAITING_APPROVAL, CommunicationStatus.APPROVED],
          },
        },
        data: {
          status: CommunicationStatus.AUTO_REJECTED,
          rejectedAt: now,
          rejectionReason: 'breathing space active',
        },
      });

      await tx.escalationFlag.create({
        data: {
          caseId: input.caseId,
          kind: EscalationFlagKind.BREATHING_SPACE,
          raisedAt: now,
          raisedReason: `Breathing space activated via ${input.source}`,
          payloadJson: {
            source: input.source,
            note: input.note ?? null,
          } as Prisma.InputJsonValue,
        },
      });

      await tx.caseEvent.create({
        data: {
          caseId: input.caseId,
          kind: CaseEventKind.BREATHING_SPACE_ACTIVATED,
          occurredAt: now,
          payloadJson: {
            source: input.source,
            note: input.note ?? null,
            chaseEntriesSkipped: skipped.count,
            draftsAutoRejected: rejected.count,
          } as Prisma.InputJsonValue,
        },
      });

      return { skipped: skipped.count, rejected: rejected.count };
    });

    // R6.6 — S8 evaluator forces s8Eligible=false when breathingSpaceActive
    // is true. Called after the transaction commits so the evaluator sees
    // the updated row.
    try {
      await this.s8.evaluate(input.caseId);
    } catch (err) {
      this.logger.warn(
        `breathing-space activate: s8 re-eval for ${input.caseId} failed — ${
          err instanceof Error ? err.message : err
        }`,
      );
    }

    return {
      caseId: input.caseId,
      breathingSpaceActive: true,
      changed: true,
      chaseEntriesSkipped: cascades.skipped,
      draftsAutoRejected: cascades.rejected,
    };
  }

  async deactivate(input: DeactivateInput): Promise<ToggleResult> {
    const caseRow = await this.assertActiveCase(input.caseId);
    if (!caseRow.breathingSpaceActive) {
      return {
        caseId: input.caseId,
        breathingSpaceActive: false,
        changed: false,
        chaseEntriesSkipped: 0,
        draftsAutoRejected: 0,
      };
    }

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();

      await tx.case.update({
        where: { id: input.caseId },
        data: { breathingSpaceActive: false },
      });

      await tx.escalationFlag.updateMany({
        where: {
          caseId: input.caseId,
          kind: EscalationFlagKind.BREATHING_SPACE,
          resolvedAt: null,
        },
        data: {
          resolvedAt: now,
          resolvedReason: input.note ?? 'Breathing space deactivated',
        },
      });

      await tx.caseEvent.create({
        data: {
          caseId: input.caseId,
          kind: CaseEventKind.BREATHING_SPACE_DEACTIVATED,
          occurredAt: now,
          payloadJson: {
            note: input.note ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    });

    // R7.3: re-evaluate S8 in case the balance is still over threshold and
    // should re-raise the flag now that breathing space is gone.
    try {
      await this.s8.evaluate(input.caseId);
    } catch (err) {
      this.logger.warn(
        `breathing-space deactivate: s8 re-eval for ${input.caseId} failed — ${
          err instanceof Error ? err.message : err
        }`,
      );
    }

    return {
      caseId: input.caseId,
      breathingSpaceActive: false,
      changed: true,
      chaseEntriesSkipped: 0,
      draftsAutoRejected: 0,
    };
  }

  private async assertActiveCase(caseId: string) {
    const caseRow = await this.prisma.case.findUnique({
      where: { id: caseId },
      select: { id: true, status: true, breathingSpaceActive: true },
    });
    if (!caseRow) throw new NotFoundException(`Case ${caseId} not found`);
    if (caseRow.status !== CaseStatus.ACTIVE) {
      throw new NotFoundException(`Case ${caseId} is not ACTIVE`);
    }
    return caseRow;
  }
}
