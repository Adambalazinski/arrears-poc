import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LwcaChargeUpsert } from '../../../integrations/lwca/lwca-invoice.mapper';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';
import { ChargesService } from '../charges.service';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 'charges-test-org';
const TENANCY_ID = 'charges-test-tenancy';

beforeAll(async () => {
  await prisma.$connect();
  await wipeOrg();
  await prisma.organisation.create({ data: { id: ORG_ID, name: 'Charges test' } });
  await prisma.tenancy.create({
    data: {
      id: TENANCY_ID,
      organisationId: ORG_ID,
      propertyId: 'p',
      status: 'ACTIVE',
      lastSyncedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await wipeOrg();
  await prisma.$disconnect();
});

let CASE_ID: string;

beforeEach(async () => {
  const created = await prisma.case.create({
    data: {
      organisationId: ORG_ID,
      tenancyId: TENANCY_ID,
      status: 'ACTIVE',
      openedAt: new Date(),
      lastKnownBalancePence: 0n,
      lastKnownBalanceAt: new Date(),
    },
  });
  CASE_ID = created.id;
});

afterEach(async () => {
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
});

async function wipeOrg(): Promise<void> {
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisation.deleteMany({ where: { id: ORG_ID } });
}

function makeService(): ChargesService {
  return new ChargesService(prisma as unknown as PrismaService);
}

function lwca(overrides: Partial<LwcaChargeUpsert> = {}): LwcaChargeUpsert {
  return {
    organisationId: ORG_ID,
    lwcaInvoiceId: 'lwca-inv-1',
    dueDate: new Date('2026-04-01T00:00:00Z'),
    invoiceDate: new Date('2026-03-15T00:00:00Z'),
    grossAmountPence: 120000n,
    lastKnownRemainAmountPence: 120000n,
    lastKnownStatus: 'UNPAID',
    lastKnownPaymentCycleType: 'MONTHLY',
    lastKnownType: 'RENT',
    lastKnownDescription: null,
    lastSyncedAt: new Date('2026-05-01T10:00:00Z'),
    upstreamReferenceId: 'INV-001',
    ...overrides,
  };
}

describe('ChargesService.upsertFromLwca', () => {
  it('creates a new charge and emits CHARGE_ADDED on first sync', async () => {
    const svc = makeService();
    const r = await svc.upsertFromLwca(CASE_ID, lwca());
    expect(r.created).toBe(true);
    expect(r.charge.lwcaInvoiceId).toBe('lwca-inv-1');
    expect(r.charge.lastKnownRemainAmountPence).toBe(120000n);
    expect(r.charge.currentStage).toBe('NOT_DUE'); // schema default

    const events = await prisma.caseEvent.findMany({ where: { caseId: CASE_ID } });
    expect(events.map((e) => e.kind)).toEqual(['CHARGE_ADDED']);
  });

  it('is idempotent: re-running with same lwcaInvoiceId updates instead of duplicating', async () => {
    const svc = makeService();
    const first = await svc.upsertFromLwca(CASE_ID, lwca());
    const second = await svc.upsertFromLwca(CASE_ID, lwca({ lastKnownRemainAmountPence: 60000n, lastKnownStatus: 'PARTIALLY_PAID' }));
    expect(second.created).toBe(false);
    expect(second.charge.id).toBe(first.charge.id);
    expect(second.charge.lastKnownRemainAmountPence).toBe(60000n);
    expect(second.charge.lastKnownStatus).toBe('PARTIALLY_PAID');

    const count = await prisma.charge.count({ where: { lwcaInvoiceId: 'lwca-inv-1' } });
    expect(count).toBe(1);

    // CHARGE_ADDED fires exactly once (on the first sync only).
    const events = await prisma.caseEvent.findMany({
      where: { caseId: CASE_ID, kind: 'CHARGE_ADDED' },
    });
    expect(events).toHaveLength(1);
  });

  it('does not mutate grossAmountPence / dueDate on subsequent syncs', async () => {
    const svc = makeService();
    await svc.upsertFromLwca(CASE_ID, lwca({ grossAmountPence: 120000n }));
    await svc.upsertFromLwca(
      CASE_ID,
      lwca({
        // pretend LWCA reports a different grossAmount on a later poll —
        // the upsert should ignore it.
        grossAmountPence: 999_999n,
        dueDate: new Date('2099-01-01T00:00:00Z'),
        lastKnownRemainAmountPence: 60000n,
      }),
    );
    const row = await prisma.charge.findUniqueOrThrow({
      where: { lwcaInvoiceId: 'lwca-inv-1' },
    });
    expect(row.grossAmountPence).toBe(120000n);
    expect(row.dueDate.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(row.lastKnownRemainAmountPence).toBe(60000n);
  });
});

describe('ChargesService.advanceStage', () => {
  it('atomically updates currentStage and currentStageEnteredAt', async () => {
    const svc = makeService();
    const { charge } = await svc.upsertFromLwca(CASE_ID, lwca());
    expect(charge.currentStage).toBe('NOT_DUE');
    expect(charge.currentStageEnteredAt).toBeNull();

    const before = Date.now();
    const advanced = await svc.advanceStage(charge.id, 'WD3_SENT');
    const after = Date.now();

    expect(advanced.currentStage).toBe('WD3_SENT');
    expect(advanced.currentStageEnteredAt).not.toBeNull();
    expect(advanced.currentStageEnteredAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(advanced.currentStageEnteredAt!.getTime()).toBeLessThanOrEqual(after);
  });

  it('throws when the charge id is unknown', async () => {
    const svc = makeService();
    await expect(svc.advanceStage('00000000-0000-0000-0000-000000000000', 'WD3_SENT')).rejects.toThrow(
      /not found/i,
    );
  });
});
