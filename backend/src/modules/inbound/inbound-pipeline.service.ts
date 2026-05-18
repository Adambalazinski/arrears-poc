import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CaseEventKind,
  CommunicationStatus,
  EscalationFlagKind,
  Prisma,
  ReviewItemKind,
  ReviewItemPriority,
  type Sentiment,
  type InboundIntent,
} from '@prisma/client';
import { Clock } from '../../common/clock/clock.service';
import {
  ANTHROPIC_CLIENT,
  AnthropicEmptyContentError,
  AnthropicJsonParseError,
  AnthropicSpendCapExceeded,
  type AnthropicClassifyInput,
  type AnthropicClassifyResult,
  type AnthropicClient,
} from '../../integrations/anthropic/anthropic-client';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import type { HardTriggerKind } from '../ai/hard-triggers';
import { PreFilterService } from '../ai/pre-filter.service';
import { REDACTOR, RedactionRequiredError, type Redactor } from '../ai/redactor';

interface PipelineCommunication {
  id: string;
  caseId: string;
  organisationId: string;
  fromAddress: string | null;
  subject: string | null;
  rawBodyText: string | null;
}

export type ClassifyFailureReason =
  | 'EMPTY_BODY'
  | 'SPEND_CAP_EXCEEDED'
  | 'REDACTION_FAILED'
  | 'JSON_PARSE_FAILED'
  | 'EMPTY_LLM_OUTPUT'
  | 'LLM_REQUEST_FAILED';

export type PipelineOutcome =
  | { status: 'NOT_FOUND' }
  | { status: 'HARD_TRIGGER'; trigger: HardTriggerKind; keyword: string }
  | { status: 'CLASSIFIED'; classification: AnthropicClassifyResult }
  | { status: 'CLASSIFY_FAILED'; reason: ClassifyFailureReason };

/**
 * Inbound pipeline per docs/architecture.md flow 3 and
 * docs/ai-decision-spec.md.
 *
 * Phase 7.3 wired the deterministic hard-trigger pre-filter; Phase 7.6
 * (this step) adds the classification call for non-trigger messages.
 *
 * Success path: redact body → classify with Haiku → persist
 * ClassificationResult + CLASSIFICATION_PRODUCED event. Communication
 * stays at RECEIVED so Phase 7.7 can pick it up for confidence-based
 * routing into either an OUTBOUND draft or the low-confidence queue.
 *
 * Failure path: every error category routes to INBOUND_LOW_CONFIDENCE
 * (priority HIGH) with the AI_CONFIDENCE_FAILURE flag raised — the
 * spec's "best-effort, never silent" rule. Communication flips to
 * PROCESSED because a handler now owns the message; ChaseScheduleEntries
 * are NOT halted (that's the hard-trigger flow's job).
 */
@Injectable()
export class InboundPipelineService {
  private readonly logger = new Logger(InboundPipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly preFilter: PreFilterService,
    @Inject(ANTHROPIC_CLIENT) private readonly anthropic: AnthropicClient,
    @Inject(REDACTOR) private readonly redactor: Redactor,
  ) {}

  async handle(communicationId: string): Promise<PipelineOutcome> {
    const comm = await this.prisma.communication.findUnique({
      where: { id: communicationId },
      select: {
        id: true,
        caseId: true,
        organisationId: true,
        fromAddress: true,
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

    return this.runClassification(comm);
  }

  private async runClassification(comm: PipelineCommunication): Promise<PipelineOutcome> {
    const body = (comm.rawBodyText ?? '').trim();
    if (!body) {
      this.logger.warn(
        `inbound-pipeline: communication ${comm.id} has empty body; routing to low-confidence queue`,
      );
      await this.onClassifyFailure(comm, 'EMPTY_BODY', 'Inbound message body was empty');
      return { status: 'CLASSIFY_FAILED', reason: 'EMPTY_BODY' };
    }

    const redactedBody = this.redactor.redact(body).text;
    const context = await this.buildClassifyContext(comm, redactedBody);

    let result: AnthropicClassifyResult;
    try {
      result = await this.anthropic.classify(context);
    } catch (err) {
      const { reason, message } = mapClassifyError(err);
      this.logger.warn(
        `inbound-pipeline: classify failed for ${comm.id} (${reason}): ${message}`,
      );
      await this.onClassifyFailure(comm, reason, message);
      return { status: 'CLASSIFY_FAILED', reason };
    }

    await this.persistClassification(comm, result);
    this.logger.log(
      `inbound-pipeline: classified ${comm.id} ` +
        `sentiment=${result.sentiment} intent=${result.intent} ` +
        `confidence=${result.confidence.toFixed(2)} costPence=${result.estimatedCostPence}`,
    );
    return { status: 'CLASSIFIED', classification: result };
  }

  private async buildClassifyContext(
    comm: PipelineCommunication,
    redactedBody: string,
  ): Promise<AnthropicClassifyInput> {
    const fromEmail = (comm.fromAddress ?? '').trim().toLowerCase();
    const contact = fromEmail
      ? await this.prisma.contact.findFirst({
          where: { organisationId: comm.organisationId, primaryEmail: fromEmail },
          select: { firstName: true },
        })
      : null;
    const senderFirstName = contact?.firstName?.trim() || 'the tenant';

    const caseRow = await this.prisma.case.findUniqueOrThrow({
      where: { id: comm.caseId },
      select: { lastKnownBalancePence: true },
    });
    const charges = await this.prisma.charge.findMany({
      where: {
        caseId: comm.caseId,
        lastKnownStatus: { in: ['UNPAID', 'PARTIALLY_PAID', 'PARTIALLY_RECONCILED'] },
      },
      select: { workingDaysOverdue: true },
    });
    const maxWorkingDaysOverdue = charges.reduce(
      (m, c) => (c.workingDaysOverdue > m ? c.workingDaysOverdue : m),
      0,
    );

    const thirtyDaysAgo = new Date(this.clock.now().getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentPayment = await this.prisma.caseEvent.findFirst({
      where: {
        caseId: comm.caseId,
        kind: { in: [CaseEventKind.CHARGE_FULLY_PAID, CaseEventKind.CHARGE_PARTIALLY_PAID] },
        occurredAt: { gte: thirtyDaysAgo },
      },
      select: { id: true },
    });

    return {
      organisationId: comm.organisationId,
      caseId: comm.caseId,
      redactedBody,
      senderFirstName,
      caseContext: {
        balancePounds: Number(caseRow.lastKnownBalancePence) / 100,
        chargeCount: charges.length,
        maxWorkingDaysOverdue,
        recentPaymentInLast30Days: Boolean(recentPayment),
      },
    };
  }

  private async persistClassification(
    comm: PipelineCommunication,
    result: AnthropicClassifyResult,
  ): Promise<void> {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.classificationResult.create({
        data: {
          caseId: comm.caseId,
          communicationId: comm.id,
          preFilterMatched: false,
          modelUsed: result.modelUsed,
          sentiment: result.sentiment as Sentiment,
          intent: result.intent as InboundIntent,
          confidence: new Prisma.Decimal(result.confidence),
          rationale: result.rationale,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          estimatedCostPence: result.estimatedCostPence,
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: comm.caseId,
          kind: CaseEventKind.CLASSIFICATION_PRODUCED,
          payloadJson: {
            communicationId: comm.id,
            modelUsed: result.modelUsed,
            sentiment: result.sentiment,
            intent: result.intent,
            confidence: result.confidence,
            costPence: result.estimatedCostPence,
          } as Prisma.InputJsonValue,
          occurredAt: now,
        },
      });
    });
  }

  private async onClassifyFailure(
    comm: PipelineCommunication,
    reason: ClassifyFailureReason,
    message: string,
  ): Promise<void> {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const flag = await tx.escalationFlag.create({
        data: {
          caseId: comm.caseId,
          kind: EscalationFlagKind.AI_CONFIDENCE_FAILURE,
          raisedReason: `Classification failed: ${reason} — ${message}`,
          payloadJson: {
            communicationId: comm.id,
            reason,
            message,
          } as Prisma.InputJsonValue,
        },
      });
      await tx.reviewQueueItem.create({
        data: {
          caseId: comm.caseId,
          organisationId: comm.organisationId,
          kind: ReviewItemKind.INBOUND_LOW_CONFIDENCE,
          priority: ReviewItemPriority.HIGH,
          communicationId: comm.id,
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: comm.caseId,
          kind: CaseEventKind.ESCALATION_FLAG_RAISED,
          payloadJson: {
            flagId: flag.id,
            kind: EscalationFlagKind.AI_CONFIDENCE_FAILURE,
            reason,
            communicationId: comm.id,
          } as Prisma.InputJsonValue,
          occurredAt: now,
        },
      });
      await tx.communication.update({
        where: { id: comm.id },
        data: { status: CommunicationStatus.PROCESSED },
      });
    });
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

function mapClassifyError(err: unknown): {
  reason: ClassifyFailureReason;
  message: string;
} {
  if (err instanceof AnthropicSpendCapExceeded) {
    return { reason: 'SPEND_CAP_EXCEEDED', message: err.message };
  }
  if (err instanceof RedactionRequiredError) {
    return { reason: 'REDACTION_FAILED', message: err.message };
  }
  if (err instanceof AnthropicJsonParseError) {
    return { reason: 'JSON_PARSE_FAILED', message: err.message };
  }
  if (err instanceof AnthropicEmptyContentError) {
    return { reason: 'EMPTY_LLM_OUTPUT', message: err.message };
  }
  return {
    reason: 'LLM_REQUEST_FAILED',
    message: err instanceof Error ? err.message : String(err),
  };
}
