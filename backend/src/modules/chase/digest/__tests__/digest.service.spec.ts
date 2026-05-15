import { PrismaClient, type Case } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../../../integrations/prisma/prisma.service';
import { DEFAULT_ORG_CONFIG } from '../../../organisations/defaults';
import { DigestService } from '../digest.service';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 'digest-test-org';
const TENANCY_ID = 'digest-tenancy-1';

async function wipe(): Promise<void> {
  await prisma.reviewQueueItem.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.communication.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.chaseScheduleEntry.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancyContact.deleteMany({
    where: { tenancy: { organisationId: ORG_ID } },
  });
  await prisma.contact.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisationConfig.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisation.deleteMany({ where: { id: ORG_ID } });
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
  await prisma.organisation.create({ data: { id: ORG_ID, name: 'Digest test' } });
  await prisma.organisationConfig.create({
    data: {
      ...DEFAULT_ORG_CONFIG,
      organisation: { connect: { id: ORG_ID } },
    },
  });
  await prisma.tenancy.create({
    data: {
      id: TENANCY_ID,
      organisationId: ORG_ID,
      propertyId: 'p',
      propertyName: 'Flat 2',
      propertyAddress1: '12 High Street',
      propertyAddress2: 'London',
      status: 'ACTIVE',
      lastSyncedAt: new Date(),
    },
  });
  await prisma.contact.create({
    data: {
      id: 'digest-test-tenant',
      organisationId: ORG_ID,
      firstName: 'Jane',
      lastName: 'Tenant',
      primaryEmail: 'jane@example.com',
      emailsJson: [],
      phonesJson: [],
      lastSyncedAt: new Date(),
    },
  });
  await prisma.tenancyContact.create({
    data: {
      tenancyId: TENANCY_ID,
      contactId: 'digest-test-tenant',
      role: 'TENANT',
    },
  });
});

afterEach(async () => {
  await wipe();
});

async function makeCase(overrides: Partial<Case> = {}): Promise<string> {
  const row = await prisma.case.create({
    data: {
      organisationId: ORG_ID,
      tenancyId: TENANCY_ID,
      status: 'ACTIVE',
      openedAt: new Date('2026-05-10T00:00:00Z'),
      lastKnownBalancePence: 0n,
      lastKnownBalanceAt: new Date(),
      ...overrides,
    },
  });
  return row.id;
}

async function makeCharge(caseId: string, lwcaId: string, remain: bigint, opts: { wd?: number } = {}): Promise<string> {
  const ch = await prisma.charge.create({
    data: {
      caseId,
      organisationId: ORG_ID,
      lwcaInvoiceId: lwcaId,
      dueDate: new Date('2026-05-01T00:00:00Z'),
      invoiceDate: new Date('2026-04-15T00:00:00Z'),
      grossAmountPence: remain,
      lastKnownRemainAmountPence: remain,
      lastKnownStatus: 'UNPAID',
      workingDaysOverdue: opts.wd ?? 5,
      lastSyncedAt: new Date(),
    },
  });
  return ch.id;
}

async function scheduleEntry(
  caseId: string,
  chargeId: string,
  stage: 'AWAITING_WD3' | 'AWAITING_WD5' | 'AWAITING_WD8' | 'AWAITING_WD14',
  dueAt: Date,
): Promise<string> {
  const e = await prisma.chaseScheduleEntry.create({
    data: { caseId, chargeId, stage, dueAt },
  });
  return e.id;
}

function makeService(): DigestService {
  return new DigestService(prisma as unknown as PrismaService);
}

const NOW = new Date('2026-05-15T09:00:00Z');

describe('DigestService.runDigest', () => {
  it('produces one Communication per case, lists all overdue charges, marks entries fired', async () => {
    const caseId = await makeCase();
    const ch1 = await makeCharge(caseId, 'inv-1', 120_000n, { wd: 8 });
    const ch2 = await makeCharge(caseId, 'inv-2', 80_000n, { wd: 5 });
    const e1 = await scheduleEntry(caseId, ch1, 'AWAITING_WD8', new Date('2026-05-15T08:00:00Z'));
    const e2 = await scheduleEntry(caseId, ch2, 'AWAITING_WD5', new Date('2026-05-15T08:00:00Z'));

    const r = await makeService().runDigest(NOW);
    expect(r.casesEvaluated).toBe(1);
    expect(r.digestsCreated).toBe(1);
    expect(r.entriesFired).toBe(2);

    const comms = await prisma.communication.findMany({
      where: { caseId },
      include: { charges: true },
    });
    expect(comms).toHaveLength(1);
    const c = comms[0]!;
    expect(c.direction).toBe('OUTBOUND');
    expect(c.status).toBe('AWAITING_APPROVAL');
    expect(c.consolidatedStage).toBe('AWAITING_WD8'); // R4.2: most severe of the two firing entries
    expect(c.recipientRole).toBe('TENANT');
    expect(c.toAddress).toBe('jane@example.com');
    expect(c.charges.map((ch) => ch.id).sort()).toEqual([ch1, ch2].sort());
    expect(c.bodyMarkdown ?? '').toContain('Jane');

    const entries = await prisma.chaseScheduleEntry.findMany({
      where: { id: { in: [e1, e2] } },
    });
    for (const e of entries) {
      expect(e.firedAt).not.toBeNull();
    }
  });

  it('creates a ReviewQueueItem with the right priority — NORMAL by default', async () => {
    const caseId = await makeCase();
    const ch1 = await makeCharge(caseId, 'inv-n1', 60_000n);
    await scheduleEntry(caseId, ch1, 'AWAITING_WD5', new Date('2026-05-15T08:00:00Z'));
    await makeService().runDigest(NOW);
    const items = await prisma.reviewQueueItem.findMany({ where: { caseId } });
    expect(items).toHaveLength(1);
    expect(items[0]!.priority).toBe('NORMAL');
    expect(items[0]!.kind).toBe('OUTBOUND_DRAFT_APPROVAL');
  });

  it('HIGH priority when AWAITING_WD14 is in the bundle', async () => {
    const caseId = await makeCase();
    const ch = await makeCharge(caseId, 'inv-h1', 200_000n);
    await scheduleEntry(caseId, ch, 'AWAITING_WD14', new Date('2026-05-15T08:00:00Z'));
    await makeService().runDigest(NOW);
    const item = await prisma.reviewQueueItem.findFirstOrThrow({ where: { caseId } });
    expect(item.priority).toBe('HIGH');
  });

  it('URGENT priority when the case is S8 eligible', async () => {
    const caseId = await makeCase({ s8Eligible: true });
    const ch = await makeCharge(caseId, 'inv-u1', 300_000n);
    await scheduleEntry(caseId, ch, 'AWAITING_WD5', new Date('2026-05-15T08:00:00Z'));
    await makeService().runDigest(NOW);
    const item = await prisma.reviewQueueItem.findFirstOrThrow({ where: { caseId } });
    expect(item.priority).toBe('URGENT');
  });

  it('skips entries whose dueAt is still in the future', async () => {
    const caseId = await makeCase();
    const ch = await makeCharge(caseId, 'inv-future', 60_000n);
    await scheduleEntry(caseId, ch, 'AWAITING_WD3', new Date('2026-05-16T08:00:00Z'));
    const r = await makeService().runDigest(NOW);
    expect(r.casesEvaluated).toBe(0);
    expect(r.digestsCreated).toBe(0);
    expect(await prisma.communication.count({ where: { caseId } })).toBe(0);
  });

  it('skips entries already fired or already skipped', async () => {
    const caseId = await makeCase();
    const ch = await makeCharge(caseId, 'inv-fired', 60_000n);
    const dueAt = new Date('2026-05-15T08:00:00Z');
    await prisma.chaseScheduleEntry.create({
      data: { caseId, chargeId: ch, stage: 'AWAITING_WD3', dueAt, firedAt: new Date() },
    });
    await prisma.chaseScheduleEntry.create({
      data: {
        caseId,
        chargeId: ch,
        stage: 'AWAITING_WD5',
        dueAt,
        firedAt: new Date(),
        skippedReason: 'BREATHING_SPACE_ACTIVE',
      },
    });
    const r = await makeService().runDigest(NOW);
    expect(r.casesEvaluated).toBe(0);
    expect(r.digestsCreated).toBe(0);
  });

  it('emits CHASE_EVENT_FIRED per entry + COMMUNICATION_DRAFTED once', async () => {
    const caseId = await makeCase();
    const ch1 = await makeCharge(caseId, 'inv-evt-1', 60_000n);
    const ch2 = await makeCharge(caseId, 'inv-evt-2', 80_000n);
    await scheduleEntry(caseId, ch1, 'AWAITING_WD3', new Date('2026-05-15T08:00:00Z'));
    await scheduleEntry(caseId, ch2, 'AWAITING_WD5', new Date('2026-05-15T08:00:00Z'));
    await makeService().runDigest(NOW);

    const fired = await prisma.caseEvent.count({
      where: { caseId, kind: 'CHASE_EVENT_FIRED' },
    });
    expect(fired).toBe(2);
    const drafted = await prisma.caseEvent.count({
      where: { caseId, kind: 'COMMUNICATION_DRAFTED' },
    });
    expect(drafted).toBe(1);
  });

  it('skips cases whose tenant contact has no primaryEmail', async () => {
    await prisma.contact.update({
      where: { id: 'digest-test-tenant' },
      data: { primaryEmail: null },
    });
    const caseId = await makeCase();
    const ch = await makeCharge(caseId, 'inv-noemail', 60_000n);
    await scheduleEntry(caseId, ch, 'AWAITING_WD3', new Date('2026-05-15T08:00:00Z'));
    const r = await makeService().runDigest(NOW);
    expect(r.digestsCreated).toBe(0);
    expect(await prisma.communication.count({ where: { caseId } })).toBe(0);
  });
});
