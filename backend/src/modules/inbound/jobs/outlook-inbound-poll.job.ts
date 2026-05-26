import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  CaseEventKind,
  CommunicationChannel,
  CommunicationDirection,
  CommunicationStatus,
  OrphanInboundReason,
  Prisma,
} from '@prisma/client';
import { Clock } from '../../../common/clock/clock.service';
import {
  OUTLOOK_CLIENT,
  type InboundMailReader,
  type InboundMessageFull,
} from '../../../integrations/outlook/outlook.types';
import { PrismaService } from '../../../integrations/prisma/prisma.service';
import { InboundCursorService } from '../inbound-cursor.service';
import { InboundPipelineService } from '../inbound-pipeline.service';
import { InboundSenderMatcher } from '../inbound-sender-matcher.service';

export type InboundPollStatus = 'SKIPPED' | 'COMPLETED' | 'FAILED';

export interface InboundPollResult {
  status: InboundPollStatus;
  processed: number;
  newCommunications: number;
  attachedToClosedCase: number;
  orphansUnmatched: number;
  orphansAmbiguous: number;
  orphansNoCase: number;
  duplicatesSkipped: number;
  cursorAdvancedTo: string | null;
}

/**
 * Outlook inbound poll per docs/integrations.md §3 and docs/architecture.md
 * flow 3.
 *
 * Every 5 min:
 *   1. since = max(cursor.lastReceivedAt − 2 min, now − 24h)
 *   2. listInbound(since); for each summary, oldest-first:
 *        skip if Communication.outlookMessageId or OrphanInbound.outlookMessageId
 *        already exists (idempotency)
 *        fetch full body
 *        match sender → Contact
 *          UNMATCHED  → OrphanInbound(UNMATCHED_SENDER), do not invoke pipeline
 *          AMBIGUOUS  → OrphanInbound(AMBIGUOUS_SENDER), do not invoke pipeline
 *          MATCHED + no case at all
 *                     → OrphanInbound(UNMATCHED_SENDER) with matched contacts noted
 *          MATCHED + only closed case
 *                     → Communication linked to closed case, emit
 *                       COMMUNICATION_RECEIVED, do NOT invoke pipeline
 *          MATCHED + active case
 *                     → Communication, emit COMMUNICATION_RECEIVED,
 *                       invoke pipeline (stub for 7.1)
 *   3. advance cursor to max receivedDateTime processed
 *
 * Tenant SyncJobRun audit is per-org in the schema, but the inbound poll
 * is mailbox-wide. The cursor row's lastPolledAt serves as the audit
 * watermark; introducing a synthetic org for SyncJobRun is a follow-up.
 *
 * Inbound mode gate: tick() only runs against the real Graph when
 * INBOUND_MODE=outlook. runOnce() is always callable directly for tests
 * and (later) dev-tools, so the gate doesn't get in the way of unit
 * coverage of the matching + persistence logic.
 */
@Injectable()
export class OutlookInboundPollJob {
  private readonly logger = new Logger(OutlookInboundPollJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly cursor: InboundCursorService,
    private readonly matcher: InboundSenderMatcher,
    private readonly pipeline: InboundPipelineService,
    @Inject(OUTLOOK_CLIENT) private readonly outlook: InboundMailReader,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (!isInboundEnabled()) {
      this.logger.debug(
        'outlook-inbound-poll: INBOUND_MODE is not "outlook", skipping scheduled tick',
      );
      return;
    }
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(
        `outlook-inbound-poll: tick failed — ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async runOnce(): Promise<InboundPollResult> {
    const now = this.clock.now();
    const sinceUtc = await this.cursor.computeSince(now);

    let summaries = await this.outlook.listInbound(sinceUtc);
    summaries = [...summaries].sort(
      (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
    );

    let processed = 0;
    let newCommunications = 0;
    let attachedToClosedCase = 0;
    let orphansUnmatched = 0;
    let orphansAmbiguous = 0;
    let orphansNoCase = 0;
    let duplicatesSkipped = 0;
    let maxReceivedAt: Date | null = null;

    for (const summary of summaries) {
      processed++;
      maxReceivedAt =
        maxReceivedAt && maxReceivedAt.getTime() > summary.receivedAt.getTime()
          ? maxReceivedAt
          : summary.receivedAt;

      const seenAsCommunication = await this.prisma.communication.findUnique({
        where: { outlookMessageId: summary.outlookMessageId },
        select: { id: true },
      });
      if (seenAsCommunication) {
        duplicatesSkipped++;
        continue;
      }
      const seenAsOrphan = await this.prisma.orphanInbound.findUnique({
        where: { outlookMessageId: summary.outlookMessageId },
        select: { id: true },
      });
      if (seenAsOrphan) {
        duplicatesSkipped++;
        continue;
      }

      const full = await this.outlook.getMessage(summary.outlookMessageId);
      const match = await this.matcher.match(full.fromAddress);

      if (match.kind === 'UNMATCHED') {
        await this.persistOrphan(full, OrphanInboundReason.UNMATCHED_SENDER, null);
        await this.markReadSafely(full.outlookMessageId);
        orphansUnmatched++;
        continue;
      }
      if (match.kind === 'AMBIGUOUS') {
        await this.persistOrphan(
          full,
          OrphanInboundReason.AMBIGUOUS_SENDER,
          match.contacts,
        );
        await this.markReadSafely(full.outlookMessageId);
        orphansAmbiguous++;
        continue;
      }

      const active = await this.matcher.findActiveCaseForContact(
        match.contactId,
        match.organisationId,
      );
      const closed = active
        ? null
        : await this.matcher.findMostRecentClosedCaseForContact(
            match.contactId,
            match.organisationId,
          );
      const caseId = active?.caseId ?? closed?.caseId ?? null;

      if (!caseId) {
        // Sender matched a contact but the contact has no cases. Persist
        // as orphan so the triage page can surface it.
        await this.persistOrphan(full, OrphanInboundReason.UNMATCHED_SENDER, [
          { contactId: match.contactId, organisationId: match.organisationId },
        ]);
        await this.markReadSafely(full.outlookMessageId);
        orphansNoCase++;
        continue;
      }

      const attachedToClosed = !active && Boolean(closed);
      const communication = await this.prisma.$transaction(async (tx) => {
        const comm = await tx.communication.create({
          data: {
            caseId,
            organisationId: match.organisationId,
            direction: CommunicationDirection.INBOUND,
            channel: CommunicationChannel.EMAIL,
            status: CommunicationStatus.RECEIVED,
            fromAddress: full.fromAddress,
            receivedAt: full.receivedAt,
            outlookMessageId: full.outlookMessageId,
            subject: full.subject,
            rawBodyText: full.bodyText,
          },
        });
        await tx.caseEvent.create({
          data: {
            caseId,
            kind: CaseEventKind.COMMUNICATION_RECEIVED,
            payloadJson: {
              communicationId: comm.id,
              outlookMessageId: full.outlookMessageId,
              fromAddress: full.fromAddress,
              attachedToClosedCase: attachedToClosed,
            },
          },
        });
        return comm;
      });
      newCommunications++;
      if (attachedToClosed) attachedToClosedCase++;

      await this.markReadSafely(full.outlookMessageId);

      // Closed-case attachment is recorded for audit but does not feed
      // the inbound pipeline — architecture flow 3 says "do not invoke AI"
      // when there is no active case.
      if (!attachedToClosed) {
        await this.pipeline.handle(communication.id);
      }
    }

    await this.cursor.advance(maxReceivedAt, now);

    this.logger.log(
      `outlook-inbound-poll processed=${processed} new=${newCommunications} closedCase=${attachedToClosedCase} orphansUnmatched=${orphansUnmatched} orphansAmbiguous=${orphansAmbiguous} orphansNoCase=${orphansNoCase} dup=${duplicatesSkipped} cursor=${maxReceivedAt?.toISOString() ?? '(unchanged)'}`,
    );
    return {
      status: 'COMPLETED',
      processed,
      newCommunications,
      attachedToClosedCase,
      orphansUnmatched,
      orphansAmbiguous,
      orphansNoCase,
      duplicatesSkipped,
      cursorAdvancedTo: maxReceivedAt?.toISOString() ?? null,
    };
  }

  /**
   * Best-effort markRead. Called after every successful ingest path —
   * Communication insert and all three orphan paths — so the shared
   * inbox naturally clears as we process. Failures here must not
   * propagate: the message is already persisted on our side and the
   * since-cursor advances, so we'd never retry markRead anyway. Log
   * and continue.
   */
  private async markReadSafely(outlookMessageId: string): Promise<void> {
    try {
      await this.outlook.markRead(outlookMessageId);
    } catch (err) {
      this.logger.warn(
        `outlook-inbound-poll: markRead(${outlookMessageId}) failed — ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async persistOrphan(
    full: InboundMessageFull,
    reasonKind: OrphanInboundReason,
    matchedContacts:
      | Array<{ contactId: string; organisationId: string }>
      | null,
  ): Promise<void> {
    await this.prisma.orphanInbound.create({
      data: {
        outlookMessageId: full.outlookMessageId,
        reasonKind,
        fromAddress: full.fromAddress,
        subject: full.subject,
        receivedAt: full.receivedAt,
        rawBodyText: full.bodyText,
        matchedContactsJson:
          matchedContacts === null
            ? Prisma.JsonNull
            : (matchedContacts as unknown as Prisma.InputJsonValue),
      },
    });
  }
}

function isInboundEnabled(): boolean {
  const mode = (process.env.INBOUND_MODE ?? 'disabled').toLowerCase();
  // Both "outlook" (Microsoft Graph) and "gmail" (generic IMAP) drive
  // the same poll loop — the OUTLOOK_CLIENT factory swaps the impl.
  return mode === 'outlook' || mode === 'gmail';
}
