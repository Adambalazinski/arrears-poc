import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../integrations/prisma/prisma.service';

const SINGLETON_ID = 'singleton';
const OVERLAP_MS = 2 * 60 * 1000; // 2-minute overlap per docs/integrations.md
const FRESH_FLOOR_MS = 24 * 60 * 60 * 1000; // floor at 24 hours back

/**
 * Singleton high-watermark for the Outlook inbound poll. We poll for
 * messages with receivedDateTime ≥ (lastReceivedAt − 2 min). The
 * 2-minute overlap absorbs Graph's eventual consistency; idempotency on
 * Communication.outlookMessageId makes the overlap a no-op when nothing
 * new arrives. On cold start the floor caps "since" at 24 hours ago.
 */
@Injectable()
export class InboundCursorService {
  constructor(private readonly prisma: PrismaService) {}

  async computeSince(now: Date): Promise<Date> {
    const row = await this.prisma.outlookPollCursor.findUnique({
      where: { id: SINGLETON_ID },
    });
    const floor = new Date(now.getTime() - FRESH_FLOOR_MS);
    if (!row?.lastReceivedAt) return floor;
    const candidate = new Date(row.lastReceivedAt.getTime() - OVERLAP_MS);
    return candidate < floor ? floor : candidate;
  }

  /**
   * Update the cursor. `lastReceivedAt` is the max receivedDateTime we
   * just processed (null when the poll returned nothing). The watermark
   * only ever moves forward, even if a backfill / clock skew tries to
   * walk it back. `lastPolledAt` is always set to the supplied `polledAt`.
   */
  async advance(lastReceivedAt: Date | null, polledAt: Date): Promise<void> {
    const existing = await this.prisma.outlookPollCursor.findUnique({
      where: { id: SINGLETON_ID },
    });
    const nextLastReceived =
      lastReceivedAt &&
      (!existing?.lastReceivedAt || lastReceivedAt > existing.lastReceivedAt)
        ? lastReceivedAt
        : (existing?.lastReceivedAt ?? null);
    await this.prisma.outlookPollCursor.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        lastReceivedAt: nextLastReceived,
        lastPolledAt: polledAt,
      },
      update: {
        lastReceivedAt: nextLastReceived,
        lastPolledAt: polledAt,
      },
    });
  }
}
