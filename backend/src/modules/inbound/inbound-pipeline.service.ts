import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CaseEventKind,
  CommunicationStatus,
  EscalationFlagKind,
  Prisma,
  ReviewItemKind,
  ReviewItemPriority,
} from '@prisma/client';
import { Clock } from '../../common/clock/clock.service';
import {
  ANTHROPIC_CLIENT,
  type AnthropicClient,
} from '../../integrations/anthropic/anthropic-client';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import type { HardTriggerKind } from '../ai/hard-triggers';
import { PreFilterService } from '../ai/pre-filter.service';

interface PipelineCommunication {
  id: string;
  caseId: string;
  organisationId: string;
  subject: string | null;
  rawBodyText: string | null;
}

export type PipelineOutcome =
  | { status: 'NOT_FOUND' }
  | { status: 'HARD_TRIGGER'; trigger: HardTriggerKind; keyword: string }
  | { status: 'AWAITING_CLASSIFICATION' };

/**
 * Inbound pipeline per docs/architecture.md flow 3 and
 * docs/ai-decision-spec.md.
 *
 * Phase 7.3 (this step) wires the deterministic hard-trigger pre-filter.
 * On match: the LLM is NEVER called; we raise an EscalationFlag of the
 * matching kind, mark the case as awaiting handler action, create an
 * URGENT review-queue item, halt any pending chase entries, emit timeline
 * events, and mark the inbound Communication as PROCESSED — all in a
 * single transaction so the audit trail is consistent.
 *
 * The pre-filter is the safety boundary: every test that exercises a
 * hard-trigger fixture must observe zero invocations on the injected
 * AnthropicClient. We inject it here in 7.3 (so the test seam exists)
 * but do not call it until Phase 7.6.
 */
@Injectable()
export class InboundPipelineService {
  private readonly logger = new Logger(InboundPipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly preFilter: PreFilterService,
    @Inject(ANTHROPIC_CLIENT) private readonly anthropic: AnthropicClient,
  ) {
    // anthropic is the explicit seam — not used in 7.3 but wired so the
    // future classification + drafting steps (7.6 / 7.7) plug straight in
    // and the hard-trigger test can assert zero invocations.
    void this.anthropic;
  }

  async handle(communicationId: string): Promise<PipelineOutcome> {
    const comm = await this.prisma.communication.findUnique({
      where: { id: communicationId },
      select: {
        id: true,
        caseId: true,
        organisationId: true,
        subject: true,
        rawBodyText: true,
      },
    });
    if (!comm) {
      this.logger.warn(
        `inbound-pipeline: communication ${communicationId} not found, skipping`,
      );
      return { status: 'NOT_FOUND' };
    }

    const scan = this.preFilter.scan({
      subject: comm.subject,
      bodyText: comm.rawBodyText ?? '',
    });

    if (scan.matched) {
      await this.onHardTrigger(comm, scan.trigger, scan.keyword);
      return { status: 'HARD_TRIGGER', trigger: scan.trigger, keyword: scan.keyword };
    }

    // Phase 7.4–7.7 land redact → classify → draft / low-confidence routing
    // here. For 7.3 we leave the communication in RECEIVED state and let
    // the next step pick it up.
    this.logger.debug(
      `inbound-pipeline: no hard trigger on ${communicationId}; classification phase not yet wired`,
    );
    return { status: 'AWAITING_CLASSIFICATION' };
  }

  private async onHardTrigger(
    comm: PipelineCommunication,
    trigger: HardTriggerKind,
    keyword: string,
  ): Promise<void> {
    const now = this.clock.now();
    const flagKind = trigger satisfies EscalationFlagKind;
    const raisedReason = `Inbound message matched hard trigger: "${keyword}"`;

    await this.prisma.$transaction(async (tx) => {
      await tx.classificationResult.create({
        data: {
          caseId: comm.caseId,
          communicationId: comm.id,
          preFilterMatched: true,
          preFilterTriggerKind: flagKind,
          preFilterMatchedKeyword: keyword,
        },
      });

      const flag = await tx.escalationFlag.create({
        data: {
          caseId: comm.caseId,
          kind: flagKind,
          raisedReason,
          payloadJson: {
            communicationId: comm.id,
            keyword,
            triggerKind: trigger,
          } as Prisma.InputJsonValue,
        },
      });

      await tx.caseEvent.create({
        data: {
          caseId: comm.caseId,
          kind: CaseEventKind.HARD_TRIGGER_MATCHED,
          payloadJson: {
            triggerKind: trigger,
            keyword,
            communicationId: comm.id,
          } as Prisma.InputJsonValue,
          occurredAt: now,
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: comm.caseId,
          kind: CaseEventKind.ESCALATION_FLAG_RAISED,
          payloadJson: {
            flagId: flag.id,
            kind: flagKind,
            reason: 'hard-trigger pre-filter match',
          } as Prisma.InputJsonValue,
          occurredAt: now,
        },
      });

      await tx.reviewQueueItem.create({
        data: {
          caseId: comm.caseId,
          organisationId: comm.organisationId,
          kind: ReviewItemKind.HARD_TRIGGER_ESCALATION,
          priority: ReviewItemPriority.URGENT,
          communicationId: comm.id,
        },
      });

      await tx.case.update({
        where: { id: comm.caseId },
        data: { awaitingHandlerAction: true },
      });

      // Halt the tenant chase track. We reuse BREATHING_SPACE_ACTIVE per
      // docs/ai-decision-spec.md ("borrowed reason; or add HARD_TRIGGER
      // variant"); a dedicated ChaseSkippedReason value is a follow-up.
      await tx.chaseScheduleEntry.updateMany({
        where: { caseId: comm.caseId, firedAt: null },
        data: { firedAt: now, skippedReason: 'BREATHING_SPACE_ACTIVE' },
      });

      // The message has been triaged into the escalation track — flip it
      // out of RECEIVED so downstream views don't treat it as untouched.
      await tx.communication.update({
        where: { id: comm.id },
        data: { status: CommunicationStatus.PROCESSED },
      });
    });

    this.logger.warn(
      `inbound-pipeline: hard trigger ${trigger} matched on communication ${comm.id} (keyword="${keyword}") — case ${comm.caseId} escalated`,
    );
  }
}
