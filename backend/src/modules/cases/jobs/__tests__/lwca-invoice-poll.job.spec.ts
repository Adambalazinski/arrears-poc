import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixtureLwcaInvoiceClient } from '../../../../integrations/lwca/fixture-lwca-invoice.client';
import type { LwcaInvoiceClient } from '../../../../integrations/lwca/lwca-invoice.client';
import { FixtureRentancyClient } from '../../../../integrations/rentancy/fixture-rentancy.client';
import type { PrismaService } from '../../../../integrations/prisma/prisma.service';
import { ChargesService } from '../../../charges/charges.service';
import { TenancyRefreshService } from '../../../tenancies/tenancy-refresh.service';
import { CasesService } from '../../cases.service';
import { S8EvaluationService } from '../../s8-evaluation.service';
import { LwcaInvoicePollJob } from '../lwca-invoice-poll.job';
import { DEFAULT_ORG_CONFIG } from '../../../organisations/defaults';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

// Fixture locations resolved from backend/ cwd.
const FIXTURE_PATH = '../fixtures/lwca/invoices-list.json';
const RENTANCY_FIXTURE_DIR = '../fixtures/rentancy';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 'demo-org'; // matches the fixture's invoice.organisationId

async function wipeAll(): Promise<void> {
  await prisma.syncJobRun.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.reviewQueueItem.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.communication.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.chaseScheduleEntry.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.escalationFlag.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.classificationResult.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancyContact.deleteMany({ where: { tenancy: { organisationId: ORG_ID } } });
  await prisma.contact.deleteMany({ where: { organisationId: ORG_ID } });
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
  await prisma.organisation.create({
    data: {
      id: ORG_ID,
      name: 'Demo',
      config: { create: { ...DEFAULT_ORG_CONFIG } },
    },
  });
});

afterEach(async () => {
  await wipeAll();
});

function makeJob(): LwcaInvoicePollJob {
  const lwca = new FixtureLwcaInvoiceClient(FIXTURE_PATH) as LwcaInvoiceClient;
  const rentancy = new FixtureRentancyClient(RENTANCY_FIXTURE_DIR);
  const cases = new CasesService(prisma as unknown as PrismaService);
  const charges = new ChargesService(prisma as unknown as PrismaService);
  const tenancyRefresh = new TenancyRefreshService(
    prisma as unknown as PrismaService,
    rentancy,
  );
  const s8 = new S8EvaluationService(prisma as unknown as PrismaService);
  return new LwcaInvoicePollJob(
    prisma as unknown as PrismaService,
    lwca,
    cases,
    charges,
    tenancyRefresh,
    s8,
  );
}

describe('LwcaInvoicePollJob.runForOrg (fixtures)', () => {
  it('opens cases, attaches charges, recomputes balances on first run', async () => {
    const job = makeJob();
    const result = await job.runForOrg(ORG_ID);

    // The fixture has 10 invoices; 7 survive the arrears filter
    // (3 on the original tenancies + 4 on the S8 demo tenancy).
    expect(result.processed).toBe(7);
    expect(result.created).toBe(7);
    expect(result.updated).toBe(0);
    expect(result.casesOpened).toBe(3);
    expect(result.casesClosed).toBe(0);
    expect(result.status).toBe('COMPLETED');

    const cases = await prisma.case.findMany({
      where: { organisationId: ORG_ID },
      orderBy: { tenancyId: 'asc' },
      include: { charges: true },
    });
    expect(cases.map((c) => c.tenancyId)).toEqual([
      'tenancy-abc-001',
      'tenancy-s8-001',
      'tenancy-xyz-002',
    ]);

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

    const s8 = cases.find((c) => c.tenancyId === 'tenancy-s8-001')!;
    expect(s8.charges.map((c) => c.lwcaInvoiceId).sort()).toEqual([
      'lwca-inv-0007',
      'lwca-inv-0008',
      'lwca-inv-0009',
      'lwca-inv-0010',
    ]);
    // 4 × £1200 = £4800 outstanding; threshold (3 months) = £3600 -> S8 raised.
    expect(s8.lastKnownBalancePence).toBe(480000n);
    expect(s8.s8Eligible).toBe(true);
  });

  it('is idempotent: re-running does not duplicate cases, charges, or events', async () => {
    const job = makeJob();
    await job.runForOrg(ORG_ID);
    const r2 = await job.runForOrg(ORG_ID);

    expect(r2.processed).toBe(7);
    expect(r2.created).toBe(0);
    expect(r2.updated).toBe(7);
    expect(r2.casesOpened).toBe(0);

    expect(await prisma.case.count({ where: { organisationId: ORG_ID } })).toBe(3);
    expect(await prisma.charge.count({ where: { organisationId: ORG_ID } })).toBe(7);

    // Exactly three CASE_OPENED events (one per case) total across both runs.
    const opened = await prisma.caseEvent.count({
      where: { case: { organisationId: ORG_ID }, kind: 'CASE_OPENED' },
    });
    expect(opened).toBe(3);

    // Exactly seven CHARGE_ADDED events.
    const added = await prisma.caseEvent.count({
      where: { case: { organisationId: ORG_ID }, kind: 'CHARGE_ADDED' },
    });
    expect(added).toBe(7);
  });

  it('upserts the Tenancy with LWCA property hints and Rentancy fields after case open', async () => {
    const job = makeJob();
    await job.runForOrg(ORG_ID);
    const t = await prisma.tenancy.findUniqueOrThrow({ where: { id: 'tenancy-abc-001' } });
    // LWCA owns property display
    expect(t.propertyId).toBe('prop-001');
    expect(t.propertyName).toBe('Flat 2');
    expect(t.propertyAddress1).toBe('12 High Street');
    expect(t.propertyAddress2).toBe('London W1 1AA');
    // Rentancy owns status / reference / rentDayOfMonth / rentAmountPence —
    // populated by the Phase 4.4 refresh kicked off on case open.
    expect(t.status).toBe('ACTIVE');
    expect(t.reference).toBe('TN-2024-001');
    expect(t.rentDayOfMonth).toBe(1);
    expect(t.rentAmountPence).toBe(120000n);
  });

  it('pulls tenant + guarantor contacts from Rentancy on case open', async () => {
    const job = makeJob();
    await job.runForOrg(ORG_ID);
    const contacts = await prisma.contact.findMany({
      where: { organisationId: ORG_ID },
      orderBy: { id: 'asc' },
    });
    expect(contacts.map((c) => c.id).sort()).toEqual([
      'contact-guarantor-001',
      'contact-tenant-001',
      'contact-tenant-002',
      'contact-tenant-003',
    ]);

    const tenant = contacts.find((c) => c.id === 'contact-tenant-001')!;
    expect(tenant.firstName).toBe('Jane');
    expect(tenant.primaryEmail).toBe('jane.tenant@example.com');

    const links = await prisma.tenancyContact.findMany({
      where: { tenancyId: 'tenancy-abc-001' },
      orderBy: { role: 'asc' },
    });
    expect(links.map((l) => `${l.role}:${l.contactId}`).sort()).toEqual([
      'GUARANTOR:contact-guarantor-001',
      'TENANT:contact-tenant-001',
    ]);
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
    expect(runs[0]!.itemsProcessed).toBe(7);
    expect(runs[0]!.itemsCreated).toBe(7);
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
    const tenancyRefresh = new TenancyRefreshService(
      prisma as unknown as PrismaService,
      new FixtureRentancyClient(RENTANCY_FIXTURE_DIR),
    );
    const s8 = new S8EvaluationService(prisma as unknown as PrismaService);
    const job = new LwcaInvoicePollJob(
      prisma as unknown as PrismaService,
      failing,
      cases,
      charges,
      tenancyRefresh,
      s8,
    );
    await expect(job.runForOrg(ORG_ID)).rejects.toThrow('boom');

    const run = await prisma.syncJobRun.findFirstOrThrow({
      where: { organisationId: ORG_ID },
    });
    expect(run.status).toBe('FAILED');
    expect(run.errorJson).toMatchObject({ message: 'boom' });
  });
});
