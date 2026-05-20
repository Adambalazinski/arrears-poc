import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CaseEventKind,
  CommunicationChannel,
  CommunicationDirection,
  CommunicationStatus,
  EscalationFlagKind,
  Prisma,
  RecipientRole,
  ReviewItemKind,
  ReviewItemPriority,
  type Charge,
  type InboundIntent,
  type Sentiment,
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
  type AnthropicDraftInput,
  type AnthropicSentiment,
  type AnthropicIntent,
} from '../../integrations/anthropic/anthropic-client';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import { buildDraftSnapshot } from '../chase/digest/digest.service';
import type { HardTriggerKind } from '../ai/hard-triggers';
import { PreFilterService } from '../ai/pre-filter.service';
import { REDACTOR, RedactionRequiredError, type Redactor } from '../ai/redactor';
import { BreathingSpaceService } from '../cases/breathing-space.service';

interface PipelineCommunication {
  id: string;
  caseId: string;
  organisationId: string;
  fromAddress: string | null;
  subject: string | null;
  rawBodyText: string | null;
}

export type LowConfidenceReason =
  | 'EMPTY_BODY'
  | 'SPEND_CAP_EXCEEDED'
  | 'REDACTION_FAILED'
  | 'JSON_PARSE_FAILED'
  | 'EMPTY_LLM_OUTPUT'
  | 'LLM_REQUEST_FAILED'
  | 'COMPLAINT_INTENT'
  | 'UNCLEAR_INTENT'
  | 'DISTRESSED_SENTIMENT'
  | 'CONFIDENCE_BELOW_THRESHOLD'
  | 'DRAFT_FAILED';

export type PipelineOutcome =
  | { status: 'NOT_FOUND' }
  | { status: 'HARD_TRIGGER'; trigger: HardTriggerKind; keyword: string }
  | {
      status: 'DRAFTED';
      classification: AnthropicClassifyResult;
      draftCommunicationId: string;
    }
  | {
      status: 'LOW_CONFIDENCE_QUEUED';
      reason: LowConfidenceReason;
      classification?: AnthropicClassifyResult;
    };

const AUTO_DRAFTABLE_INTENTS: ReadonlySet<AnthropicIntent> = new Set([
  'PAYMENT_PROMISE',
  'PAYMENT_CONFIRMATION',
  'QUERY',
  'REQUEST_FOR_INFO',
]);

const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

const ARREARS_CHARGE_STATUSES = [
  'UNPAID',
  'PARTIALLY_PAID',
  'PARTIALLY_RECONCILED',
] as const;

/**
 * Inbound pipeline per docs/architecture.md flow 3 and
 * docs/ai-decision-spec.md.
 *
 * Phase 7.3 wired the hard-trigger pre-filter; Phase 7.6 added Haiku
 * classification with a fail-soft route to INBOUND_LOW_CONFIDENCE;
 * Phase 7.7 (this step) adds confidence + intent + sentiment routing
 * and the Sonnet drafting call.
 *
 * Routing rules (post-classify, no hard trigger):
 *   - intent ∈ {COMPLAINT, UNCLEAR}         → low-confidence queue + flag
 *   - sentiment == DISTRESSED               → low-confidence queue (no flag)
 *   - confidence < org threshold (0.75)     → low-confidence queue + flag
 *   - else                                  → Sonnet draft → OUTBOUND
 *                                             AWAITING_APPROVAL +
 *                                             OUTBOUND_DRAFT_APPROVAL
 *                                             review item (NORMAL)
 *
 * Draft persistence includes draftSnapshotJson so the existing R9
 * balance-changed-since-draft check in ReviewQueueService applies
 * uniformly to digest drafts and AI-generated reply drafts.
 *
 * Every failure mode lands the message on a handler's queue — the
 * spec's "best-effort, never silent" rule. ChaseScheduleEntries are
 * NOT halted except for hard triggers.
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
    private readonly breathingSpace: BreathingSpaceService,
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
      await this.routeLowConfidence(comm, 'EMPTY_BODY', 'Inbound message body was empty');
      return { status: 'LOW_CONFIDENCE_QUEUED', reason: 'EMPTY_BODY' };
    }

    const redactedBody = this.redactor.redact(body).text;
    const senderFirstName = await this.lookupSenderFirstName(comm);
    const caseSnapshot = await this.fetchCaseSnapshot(comm.caseId);
    const recentPayment = await this.hasRecentPayment(comm.caseId);

    const classifyInput: AnthropicClassifyInput = {
      organisationId: comm.organisationId,
      caseId: comm.caseId,
      redactedBody,
      senderFirstName,
      caseContext: {
        balancePounds: caseSnapshot.balancePounds,
        chargeCount: caseSnapshot.arrearsChargeCount,
        maxWorkingDaysOverdue: caseSnapshot.maxWorkingDaysOverdue,
        recentPaymentInLast30Days: recentPayment,
      },
    };

    let result: AnthropicClassifyResult;
    try {
      result = await this.anthropic.classify(classifyInput);
    } catch (err) {
      const { reason, message } = mapClassifyError(err);
      this.logger.warn(
        `inbound-pipeline: classify failed for ${comm.id} (${reason}): ${message}`,
      );
      await this.routeLowConfidence(comm, reason, message);
      return { status: 'LOW_CONFIDENCE_QUEUED', reason };
    }

    await this.persistClassification(comm, result);
    this.logger.log(
      `inbound-pipeline: classified ${comm.id} ` +
        `sentiment=${result.sentiment} intent=${result.intent} ` +
        `confidence=${result.confidence.toFixed(2)} costPence=${result.estimatedCostPence}`,
    );

    return this.routeAfterClassification(comm, result, {
      redactedBody,
      senderFirstName,
      caseSnapshot,
    });
  }

  private async routeAfterClassification(
    comm: PipelineCommunication,
    classification: AnthropicClassifyResult,
    inputs: {
      redactedBody: string;
      senderFirstName: string;
      caseSnapshot: CaseSnapshot;
    },
  ): Promise<PipelineOutcome> {
    const reason = await this.decideRouting(comm.organisationId, classification);
    if (reason !== null) {
      await this.routeLowConfidence(
        comm,
        reason,
        `Classified as ${classification.intent}/${classification.sentiment} ` +
          `at confidence ${classification.confidence.toFixed(2)}`,
      );
      return { status: 'LOW_CONFIDENCE_QUEUED', reason, classification };
    }

    return this.runDraft(comm, classification, inputs);
  }

  private async decideRouting(
    organisationId: string,
    classification: AnthropicClassifyResult,
  ): Promise<LowConfidenceReason | null> {
    if (classification.intent === 'COMPLAINT') return 'COMPLAINT_INTENT';
    if (classification.intent === 'UNCLEAR') return 'UNCLEAR_INTENT';
    if (classification.sentiment === 'DISTRESSED') return 'DISTRESSED_SENTIMENT';
    if (!AUTO_DRAFTABLE_INTENTS.has(classification.intent)) {
      // Defensive — every non-AUTO_DRAFTABLE intent is already covered
      // above. Future intents added to the schema fall through here so
      // adding them doesn't silently start auto-drafting.
      return 'UNCLEAR_INTENT';
    }
    const threshold = await this.getConfidenceThreshold(organisationId);
    if (classification.confidence < threshold) return 'CONFIDENCE_BELOW_THRESHOLD';
    return null;
  }

  private async runDraft(
    comm: PipelineCommunication,
    classification: AnthropicClassifyResult,
    inputs: { redactedBody: string; senderFirstName: string; caseSnapshot: CaseSnapshot },
  ): Promise<PipelineOutcome> {
    const draftInput: AnthropicDraftInput = {
      organisationId: comm.organisationId,
      caseId: comm.caseId,
      redactedBody: inputs.redactedBody,
      senderFirstName: inputs.senderFirstName,
      caseContext: {
        balancePounds: inputs.caseSnapshot.balancePounds,
        chargeCount: inputs.caseSnapshot.arrearsChargeCount,
        maxChargeAmountPounds: inputs.caseSnapshot.mostOverdueChargeGrossPounds,
        maxChargeDueDateFormatted: inputs.caseSnapshot.mostOverdueChargeDueDateFormatted,
        maxWorkingDaysOverdue: inputs.caseSnapshot.maxWorkingDaysOverdue,
      },
      classification: {
        sentiment: classification.sentiment as AnthropicSentiment,
        intent: classification.intent as AnthropicIntent,
      },
    };

    let draftResult;
    try {
      draftResult = await this.anthropic.draftReply(draftInput);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `inbound-pipeline: draftReply failed for ${comm.id}: ${message}`,
      );
      await this.routeLowConfidence(comm, 'DRAFT_FAILED', message);
      return { status: 'LOW_CONFIDENCE_QUEUED', reason: 'DRAFT_FAILED', classification };
    }

    const charges = await this.prisma.charge.findMany({
      where: { caseId: comm.caseId },
    });
    const snapshot = buildDraftSnapshot(charges);
    const subject = deriveReplySubject(comm.subject);
    const toAddress = comm.fromAddress;
    if (!toAddress) {
      // Defensive — inbound polling always populates fromAddress, but if
      // the column is null we can't send a reply. Treat as a draft
      // failure so the message lands in the queue rather than silently
      // dying.
      this.logger.warn(
        `inbound-pipeline: communication ${comm.id} has no fromAddress; cannot draft reply`,
      );
      await this.routeLowConfidence(
        comm,
        'DRAFT_FAILED',
        'Inbound communication has no fromAddress for reply',
      );
      return { status: 'LOW_CONFIDENCE_QUEUED', reason: 'DRAFT_FAILED', classification };
    }

    const now = this.clock.now();
    const draftCommunicationId = await this.prisma.$transaction(async (tx) => {
      const classificationRow = await tx.classificationResult.findUnique({
        where: { communicationId: comm.id },
        select: { id: true },
      });
      const draftComm = await tx.communication.create({
        data: {
          caseId: comm.caseId,
          organisationId: comm.organisationId,
          direction: CommunicationDirection.OUTBOUND,
          channel: CommunicationChannel.EMAIL,
          status: CommunicationStatus.AWAITING_APPROVAL,
          toAddress,
          recipientRole: RecipientRole.TENANT,
          subject,
          bodyMarkdown: draftResult.bodyMarkdown,
          draftedByAi: true,
          draftSnapshotJson: snapshot as unknown as Prisma.InputJsonValue,
          charges: { connect: charges.map((c) => ({ id: c.id })) },
        },
      });
      await tx.reviewQueueItem.create({
        data: {
          caseId: comm.caseId,
          organisationId: comm.organisationId,
          kind: ReviewItemKind.OUTBOUND_DRAFT_APPROVAL,
          priority: ReviewItemPriority.NORMAL,
          communicationId: draftComm.id,
          classificationResultId: classificationRow?.id ?? null,
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: comm.caseId,
          kind: CaseEventKind.COMMUNICATION_DRAFTED,
          payloadJson: {
            inboundCommunicationId: comm.id,
            draftCommunicationId: draftComm.id,
            modelUsed: draftResult.modelUsed,
            classification: {
              sentiment: classification.sentiment,
              intent: classification.intent,
              confidence: classification.confidence,
            },
            costPence: draftResult.estimatedCostPence,
            draftedByAi: true,
          } as Prisma.InputJsonValue,
          occurredAt: now,
        },
      });
      await tx.communication.update({
        where: { id: comm.id },
        data: { status: CommunicationStatus.PROCESSED },
      });
      return draftComm.id;
    });

    this.logger.log(
      `inbound-pipeline: drafted reply for ${comm.id} → outbound=${draftCommunicationId} ` +
        `model=${draftResult.modelUsed} costPence=${draftResult.estimatedCostPence}`,
    );
    return { status: 'DRAFTED', classification, draftCommunicationId };
  }

  private async routeLowConfidence(
    comm: PipelineCommunication,
    reason: LowConfidenceReason,
    message: string,
  ): Promise<void> {
    const now = this.clock.now();
    const raiseFlag = shouldRaiseFlagFor(reason);
    await this.prisma.$transaction(async (tx) => {
      let flagId: string | null = null;
      if (raiseFlag) {
        const flag = await tx.escalationFlag.create({
          data: {
            caseId: comm.caseId,
            kind: EscalationFlagKind.AI_CONFIDENCE_FAILURE,
            raisedReason: `Inbound routed to low-confidence queue: ${reason} — ${message}`,
            payloadJson: {
              communicationId: comm.id,
              reason,
              message,
            } as Prisma.InputJsonValue,
          },
        });
        flagId = flag.id;
      }
      // When classify succeeded but routing chose low-confidence (or
      // when draft failed downstream), a ClassificationResult row
      // exists on the inbound — link it so the UI can show the
      // rationale. For pre-classify failures (EMPTY_BODY, SPEND_CAP,
      // etc.) there's no row and this stays null.
      const classificationRow = await tx.classificationResult.findUnique({
        where: { communicationId: comm.id },
        select: { id: true },
      });
      await tx.reviewQueueItem.create({
        data: {
          caseId: comm.caseId,
          organisationId: comm.organisationId,
          kind: ReviewItemKind.INBOUND_LOW_CONFIDENCE,
          priority: ReviewItemPriority.HIGH,
          communicationId: comm.id,
          classificationResultId: classificationRow?.id ?? null,
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId: comm.caseId,
          kind: raiseFlag
            ? CaseEventKind.ESCALATION_FLAG_RAISED
            : CaseEventKind.CLASSIFICATION_PRODUCED,
          payloadJson: {
            flagId,
            reason,
            message,
            communicationId: comm.id,
            routedToLowConfidence: true,
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

  private async lookupSenderFirstName(comm: PipelineCommunication): Promise<string> {
    const fromEmail = (comm.fromAddress ?? '').trim().toLowerCase();
    if (!fromEmail) return 'the tenant';
    const contact = await this.prisma.contact.findFirst({
      where: { organisationId: comm.organisationId, primaryEmail: fromEmail },
      select: { firstName: true },
    });
    return contact?.firstName?.trim() || 'the tenant';
  }

  private async fetchCaseSnapshot(caseId: string): Promise<CaseSnapshot> {
    const caseRow = await this.prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      select: { lastKnownBalancePence: true },
    });
    const charges = await this.prisma.charge.findMany({
      where: {
        caseId,
        lastKnownStatus: { in: [...ARREARS_CHARGE_STATUSES] },
      },
      orderBy: [{ workingDaysOverdue: 'desc' }, { dueDate: 'asc' }],
    });
    const mostOverdue: Charge | undefined = charges[0];
    return {
      balancePounds: Number(caseRow.lastKnownBalancePence) / 100,
      arrearsChargeCount: charges.length,
      maxWorkingDaysOverdue: mostOverdue?.workingDaysOverdue ?? 0,
      mostOverdueChargeGrossPounds: mostOverdue
        ? Number(mostOverdue.grossAmountPence) / 100
        : 0,
      mostOverdueChargeDueDateFormatted: mostOverdue
        ? formatLongDate(mostOverdue.dueDate)
        : 'unknown',
    };
  }

  private async hasRecentPayment(caseId: string): Promise<boolean> {
    const thirtyDaysAgo = new Date(this.clock.now().getTime() - 30 * 24 * 60 * 60 * 1000);
    const event = await this.prisma.caseEvent.findFirst({
      where: {
        caseId,
        kind: { in: [CaseEventKind.CHARGE_FULLY_PAID, CaseEventKind.CHARGE_PARTIALLY_PAID] },
        occurredAt: { gte: thirtyDaysAgo },
      },
      select: { id: true },
    });
    return Boolean(event);
  }

  private async getConfidenceThreshold(organisationId: string): Promise<number> {
    const config = await this.prisma.organisationConfig.findUnique({
      where: { organisationId },
      select: { aiConfidenceThreshold: true },
    });
    return config?.aiConfidenceThreshold?.toNumber() ?? DEFAULT_CONFIDENCE_THRESHOLD;
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
      const classificationRow = await tx.classificationResult.create({
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
          classificationResultId: classificationRow.id,
        },
      });

      await tx.case.update({
        where: { id: comm.caseId },
        data: { awaitingHandlerAction: true },
      });

      // BREATHING_SPACE keeps its own reason because the auto-activation
      // cascade (R7.1.b, fired right after this transaction) is what
      // semantically caused the skip. For other triggers the audit trail
      // should reflect the actual cause — the hard-trigger escalation
      // itself.
      const skipReason =
        trigger === EscalationFlagKind.BREATHING_SPACE
          ? 'BREATHING_SPACE_ACTIVE'
          : 'HARD_TRIGGER_ESCALATION';
      await tx.chaseScheduleEntry.updateMany({
        where: { caseId: comm.caseId, firedAt: null },
        data: { firedAt: now, skippedReason: skipReason },
      });

      await tx.communication.update({
        where: { id: comm.id },
        data: { status: CommunicationStatus.PROCESSED },
      });
    });

    this.logger.warn(
      `inbound-pipeline: hard trigger ${trigger} matched on communication ${comm.id} (keyword="${keyword}") — case ${comm.caseId} escalated`,
    );

    // R7.1.b — tenant-mention-via-email path. When the trigger is
    // BREATHING_SPACE, run the full breathing-space activation cascade
    // (set the case flag, auto-reject pending tenant drafts, suppress S8,
    // emit the BREATHING_SPACE_ACTIVATED event). The flag itself was
    // already raised above; activate() is idempotent against that.
    if (trigger === EscalationFlagKind.BREATHING_SPACE) {
      try {
        await this.breathingSpace.activate({
          caseId: comm.caseId,
          source: 'TENANT_EMAIL_MENTION',
          note: `Inbound message matched keyword "${keyword}"`,
        });
      } catch (err) {
        this.logger.error(
          `inbound-pipeline: breathing-space auto-activation failed for case ${comm.caseId} — ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  }
}

interface CaseSnapshot {
  balancePounds: number;
  arrearsChargeCount: number;
  maxWorkingDaysOverdue: number;
  mostOverdueChargeGrossPounds: number;
  mostOverdueChargeDueDateFormatted: string;
}

function shouldRaiseFlagFor(reason: LowConfidenceReason): boolean {
  // DISTRESSED is a soft signal per docs/ai-decision-spec.md:
  // routes to low-confidence WITHOUT raising the AI_CONFIDENCE_FAILURE
  // flag (handlers look at it but it isn't an escalation).
  return reason !== 'DISTRESSED_SENTIMENT';
}

function deriveReplySubject(inboundSubject: string | null): string {
  const trimmed = (inboundSubject ?? '').trim();
  if (!trimmed) return 'Regarding your account';
  if (/^re:\s/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

function formatLongDate(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/London',
  }).format(d);
}

function mapClassifyError(err: unknown): {
  reason: LowConfidenceReason;
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
