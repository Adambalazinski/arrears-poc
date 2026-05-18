import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';
import { InboundCursorService } from '../inbound-cursor.service';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

async function wipe(): Promise<void> {
  await prisma.outlookPollCursor.deleteMany({});
}

beforeAll(async () => {
  await prisma.$connect();
  await wipe();
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await wipe();
});

afterEach(async () => {
  await wipe();
});

function makeCursor(): InboundCursorService {
  return new InboundCursorService(prisma as unknown as PrismaService);
}

describe('InboundCursorService.computeSince', () => {
  it('falls back to now − 24h on a cold start (no row)', async () => {
    const now = new Date('2026-05-15T12:00:00Z');
    const since = await makeCursor().computeSince(now);
    expect(since.toISOString()).toBe('2026-05-14T12:00:00.000Z');
  });

  it('subtracts a 2-minute overlap from lastReceivedAt', async () => {
    await prisma.outlookPollCursor.create({
      data: {
        id: 'singleton',
        lastReceivedAt: new Date('2026-05-15T11:55:00Z'),
        lastPolledAt: new Date('2026-05-15T11:55:00Z'),
      },
    });
    const now = new Date('2026-05-15T12:00:00Z');
    const since = await makeCursor().computeSince(now);
    // 11:55 − 2 min = 11:53
    expect(since.toISOString()).toBe('2026-05-15T11:53:00.000Z');
  });

  it('floors at now − 24h when cursor is much older than that', async () => {
    await prisma.outlookPollCursor.create({
      data: {
        id: 'singleton',
        lastReceivedAt: new Date('2025-01-01T00:00:00Z'),
        lastPolledAt: new Date('2025-01-01T00:00:00Z'),
      },
    });
    const now = new Date('2026-05-15T12:00:00Z');
    const since = await makeCursor().computeSince(now);
    expect(since.toISOString()).toBe('2026-05-14T12:00:00.000Z');
  });
});

describe('InboundCursorService.advance', () => {
  it('writes a fresh singleton row on first advance', async () => {
    const polledAt = new Date('2026-05-15T12:00:00Z');
    const lastReceived = new Date('2026-05-15T11:59:00Z');
    await makeCursor().advance(lastReceived, polledAt);

    const row = await prisma.outlookPollCursor.findUnique({ where: { id: 'singleton' } });
    expect(row?.lastReceivedAt?.toISOString()).toBe(lastReceived.toISOString());
    expect(row?.lastPolledAt?.toISOString()).toBe(polledAt.toISOString());
  });

  it('moves the watermark forward only', async () => {
    const c = makeCursor();
    await c.advance(new Date('2026-05-15T11:00:00Z'), new Date('2026-05-15T11:00:01Z'));
    // Try to walk it back.
    await c.advance(new Date('2026-05-15T10:00:00Z'), new Date('2026-05-15T11:05:01Z'));
    const row = await prisma.outlookPollCursor.findUnique({ where: { id: 'singleton' } });
    expect(row?.lastReceivedAt?.toISOString()).toBe('2026-05-15T11:00:00.000Z');
    // lastPolledAt always updates
    expect(row?.lastPolledAt?.toISOString()).toBe('2026-05-15T11:05:01.000Z');
  });

  it('updates lastPolledAt without changing lastReceivedAt when called with null', async () => {
    const c = makeCursor();
    await c.advance(new Date('2026-05-15T11:00:00Z'), new Date('2026-05-15T11:00:01Z'));
    await c.advance(null, new Date('2026-05-15T11:30:01Z'));
    const row = await prisma.outlookPollCursor.findUnique({ where: { id: 'singleton' } });
    expect(row?.lastReceivedAt?.toISOString()).toBe('2026-05-15T11:00:00.000Z');
    expect(row?.lastPolledAt?.toISOString()).toBe('2026-05-15T11:30:01.000Z');
  });
});
