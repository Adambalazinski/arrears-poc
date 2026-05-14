import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixtureLwcaInvoiceClient } from '../../../../integrations/lwca/fixture-lwca-invoice.client';
import type { LwcaInvoiceClient } from '../../../../integrations/lwca/lwca-invoice.client';
import type { PrismaService } from '../../../../integrations/prisma/prisma.service';
import { ChargesService } from '../../../charges/charges.service';
import { CasesService } from '../../cases.service';
import { LwcaInvoicePollJob } from '../lwca-invoice-poll.job';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

// LWCA fixture lives at <repo>/fixtures/lwca/invoices-list.json. tests run
// from backend/ so we point the fixture path at it explicitly.
const FIXTURE_PATH = '../fixtures/lwca/invoices-list.json';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 'demo-org'; // matches the fixture's invoice.organisationId

async function wipeAll(): Promise<void> {
  await prisma.syncJobRun.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.reviewQueueItem.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.communication.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.chaseScheduleEntry.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancyContact.deleteMany({ where: { tenancy: { organisationId: ORG_ID } } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisationCredential.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisationConfig.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisation.deleteMany({ where: { id: ORG_ID } });
}

beforeAll(async () => {
  await prisma.$connect();
  await wipeAll();
});

afterAll(async () => {
  await wipeAll();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await wipeAll();
  await prisma.organisation.create({ data: { id: ORG_ID, name: 'Demo' } });
});

afterEach(async () => {
  await wipeAll();
});

function makeJob(): LwcaInvoicePollJob {
  const lwca = new FixtureLwcaInvoiceClient(FIXTURE_PATH) as LwcaInvoiceClient;
  const cases = new CasesService(prisma as unknown as PrismaService);
  const charges = new ChargesService(prisma as unknown as PrismaService);
  return new LwcaInvoicePollJob(
    prisma as unknown as PrismaService,
    lwca,
    cases,
    charges,
  );
}

describe('LwcaInvoicePollJob.runForOrg (fixtures)', () => {
  it('opens cases, attaches charges, recomputes balances on first run', async () => {
    const job = makeJob();
    const result = await job.runForOrg(ORG_ID);

    // The fixture has 6 invoices; 3 survive the arrears filter.
    expect(result.processed).toBe(3);
    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.casesOpened).toBe(2);
    expect(result.casesClosed).toBe(0);
    expect(result.status).toBe('COMPLETED');

    const cases = await prisma.case.findMany({
      where: { organisationId: ORG_ID },
      orderBy: { tenancyId: 'asc' },
      include: { charges: true },
    });
    expect(cases.map((c) => c.tenancyId)).toEqual(['tenancy-abc-001', 'tenancy-xyz-002']);

    const abc = cases.find((c) => c.tenancyId === 'tenancy-abc-001')!;
    expect(abc.charges.map((c) => c.lwcaInvoiceId).sort()).toEqual([
      'lwca-inv-0001',
      'lwca-inv-0002',
    ]);
    // 120,000 + 80,000 = 200,000 pence on the abc tenancy
    expect(abc.lastKnownBalancePence).toBe(200000n);

    const xyz = cases.find((c) => c.tenancyId === 'tenancy-xyz-002')!;
    expect(xyz.charges.map((c) => c.lwcaInvoiceId)).toEqual(['lwca-inv-0003']);
    expect(xyz.lastKnownBalancePence).toBe(120000n);
  });

  it('is idempotent: re-running does not duplicate cases, charges, or events', async () => {
    const job = makeJob();
    await job.runForOrg(ORG_ID);
    const r2 = await job.runForOrg(ORG_ID);

    expect(r2.processed).toBe(3);
    expect(r2.created).toBe(0);
    expect(r2.updated).toBe(3);
    expect(r2.casesOpened).toBe(0);

    expect(await prisma.case.count({ where: { organisationId: ORG_ID } })).toBe(2);
    expect(await prisma.charge.count({ where: { organisationId: ORG_ID } })).toBe(3);

    // Exactly two CASE_OPENED events (one per case) total across both runs.
    const opened = await prisma.caseEvent.count({
      where: { case: { organisationId: ORG_ID }, kind: 'CASE_OPENED' },
    });
    expect(opened).toBe(2);

    // Exactly three CHARGE_ADDED events.
    const added = await prisma.caseEvent.count({
      where: { case: { organisationId: ORG_ID }, kind: 'CHARGE_ADDED' },
    });
    expect(added).toBe(3);
  });

  it('upserts the Tenancy stub with property hints from LWCA', async () => {
    const job = makeJob();
    await job.runForOrg(ORG_ID);
    const t = await prisma.tenancy.findUniqueOrThrow({ where: { id: 'tenancy-abc-001' } });
    expect(t.propertyId).toBe('prop-001');
    expect(t.propertyName).toBe('Flat 2');
    expect(t.propertyAddress1).toBe('12 High Street');
    expect(t.propertyAddress2).toBe('London W1 1AA');
    // Stub status until Phase 4.4 enriches from Rentancy
    expect(t.status).toBe('UNKNOWN');
  });

  it('writes a SyncJobRun audit row with COMPLETED status and counts', async () => {
    const job = makeJob();
    await job.runForOrg(ORG_ID);
    const runs = await prisma.syncJobRun.findMany({
      where: { organisationId: ORG_ID, kind: 'LWCA_INVOICE_POLL' },
      orderBy: { startedAt: 'asc' },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('COMPLETED');
    expect(runs[0]!.itemsProcessed).toBe(3);
    expect(runs[0]!.itemsCreated).toBe(3);
    expect(runs[0]!.itemsUpdated).toBe(0);
    expect(runs[0]!.finishedAt).not.toBeNull();
  });

  it('records a FAILED SyncJobRun and rethrows when the upstream call fails', async () => {
    const failing: LwcaInvoiceClient = {
      listArrears: () => Promise.reject(new Error('boom')),
      probe: () => Promise.resolve({ ok: false, message: 'n/a', latencyMs: 0 }),
    };
    const cases = new CasesService(prisma as unknown as PrismaService);
    const charges = new ChargesService(prisma as unknown as PrismaService);
    const job = new LwcaInvoicePollJob(
      prisma as unknown as PrismaService,
      failing,
      cases,
      charges,
    );
    await expect(job.runForOrg(ORG_ID)).rejects.toThrow('boom');

    const run = await prisma.syncJobRun.findFirstOrThrow({
      where: { organisationId: ORG_ID },
    });
    expect(run.status).toBe('FAILED');
    expect(run.errorJson).toMatchObject({ message: 'boom' });
  });
});
