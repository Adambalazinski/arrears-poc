import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Clock } from '../../../../common/clock/clock.service';
import type { BankHolidaysLoader } from '../../../../common/working-day/bank-holidays.loader';
import type { GovUkBankHolidays } from '../../../../common/working-day/types';
import { WorkingDayService } from '../../../../common/working-day/working-day.service';
import { FixtureLwcaInvoiceClient } from '../../../../integrations/lwca/fixture-lwca-invoice.client';
import type { LwcaInvoiceClient } from '../../../../integrations/lwca/lwca-invoice.client';
import { FixtureRentancyClient } from '../../../../integrations/rentancy/fixture-rentancy.client';
import type { PrismaService } from '../../../../integrations/prisma/prisma.service';
import { ChargesService } from '../../../charges/charges.service';
import { ChaseTickService } from '../../../chase/chase-tick.service';
import { DigestService } from '../../../chase/digest/digest.service';
import { TenancyRefreshService } from '../../../tenancies/tenancy-refresh.service';
import { CasesService } from '../../cases.service';
import { S8EvaluationService } from '../../s8-evaluation.service';
import { LwcaInvoicePollJob } from '../lwca-invoice-poll.job';
import { DEFAULT_ORG_CONFIG } from '../../../organisations/defaults';

function makeClock(): Clock {
  return new Clock();
}

const EMPTY_CALENDAR: GovUkBankHolidays = {
  'england-and-wales': { division: 'england-and-wales', events: [] },
};

function makeWorkingDay(): WorkingDayService {
  const svc = new WorkingDayService({} as BankHolidaysLoader);
  svc.applyCalendar(EMPTY_CALENDAR);
  return svc;
}

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
  const charges = new ChargesService(prisma as unknown as PrismaService, makeWorkingDay());
  const tenancyRefresh = new TenancyRefreshService(
    prisma as unknown as PrismaService,
    rentancy,
  );
  const s8 = new S8EvaluationService(prisma as unknown as PrismaService);
  const clock = makeClock();
  const chaseTick = new ChaseTickService(prisma as unknown as PrismaService, makeWorkingDay(), clock);
  const digest = new DigestService(prisma as unknown as PrismaService, clock);
  return new LwcaInvoicePollJob(
    prisma as unknown as PrismaService,
    lwca,
    cases,
    charges,
    tenancyRefresh,
    s8,
    chaseTick,
    digest,
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
      listAllRaw: () => Promise.reject(new Error('boom')),
      getInvoice: () => Promise.reject(new Error('boom')),
      probe: () => Promise.resolve({ ok: false, message: 'n/a', latencyMs: 0 }),
    };
    const cases = new CasesService(prisma as unknown as PrismaService);
    const charges = new ChargesService(prisma as unknown as PrismaService, makeWorkingDay());
    const tenancyRefresh = new TenancyRefreshService(
      prisma as unknown as PrismaService,
      new FixtureRentancyClient(RENTANCY_FIXTURE_DIR),
    );
    const s8 = new S8EvaluationService(prisma as unknown as PrismaService);
    const clock = makeClock();
    const chaseTick = new ChaseTickService(prisma as unknown as PrismaService, makeWorkingDay(), clock);
    const digest = new DigestService(prisma as unknown as PrismaService, clock);
    const job = new LwcaInvoicePollJob(
      prisma as unknown as PrismaService,
      failing,
      cases,
      charges,
      tenancyRefresh,
      s8,
      chaseTick,
      digest,
    );
    await expect(job.runForOrg(ORG_ID)).rejects.toThrow('boom');

    const run = await prisma.syncJobRun.findFirstOrThrow({
      where: { organisationId: ORG_ID },
    });
    expect(run.status).toBe('FAILED');
    expect(run.errorJson).toMatchObject({ message: 'boom' });
  });
});

describe('LwcaInvoicePollJob.runForOrg — defect 2: stale-charge refresh', () => {
  /**
   * The arrears list filters by `statuses=UNPAID,PARTIALLY_PAID,
   * PARTIALLY_RECONCILED`, so a charge that just got paid in LWCA
   * never comes back through `listArrears`. The poll job must spot
   * the gap and hit `GET /v1/api/invoice/{id}` directly to refresh.
   */

  function makeJobWithStub(lwca: LwcaInvoiceClient): LwcaInvoicePollJob {
    const rentancy = new FixtureRentancyClient(RENTANCY_FIXTURE_DIR);
    const cases = new CasesService(prisma as unknown as PrismaService);
    const charges = new ChargesService(
      prisma as unknown as PrismaService,
      makeWorkingDay(),
    );
    const tenancyRefresh = new TenancyRefreshService(
      prisma as unknown as PrismaService,
      rentancy,
    );
    const s8 = new S8EvaluationService(prisma as unknown as PrismaService);
    const clock = makeClock();
    const chaseTick = new ChaseTickService(prisma as unknown as PrismaService, makeWorkingDay(), clock);
    const digest = new DigestService(prisma as unknown as PrismaService, clock);
    return new LwcaInvoicePollJob(
      prisma as unknown as PrismaService,
      lwca,
      cases,
      charges,
      tenancyRefresh,
      s8,
      chaseTick,
      digest,
    );
  }

  /** Seed one ACTIVE case + one UNPAID charge ahead of the test. */
  async function seedActiveUnpaidCharge(invoiceId: string): Promise<{
    caseId: string;
    chargeId: string;
  }> {
    await prisma.tenancy.upsert({
      where: { id: 'stale-tenancy-1' },
      create: {
        id: 'stale-tenancy-1',
        organisationId: ORG_ID,
        propertyId: 'stale-prop',
        status: 'ACTIVE',
        lastSyncedAt: new Date(),
      },
      update: {},
    });
    const c = await prisma.case.create({
      data: {
        organisationId: ORG_ID,
        tenancyId: 'stale-tenancy-1',
        status: 'ACTIVE',
        openedAt: new Date(),
        lastKnownBalancePence: 120000n,
        lastKnownBalanceAt: new Date(),
      },
    });
    const ch = await prisma.charge.create({
      data: {
        caseId: c.id,
        organisationId: ORG_ID,
        lwcaInvoiceId: invoiceId,
        dueDate: new Date('2026-03-01T00:00:00Z'),
        invoiceDate: new Date('2026-02-15T00:00:00Z'),
        grossAmountPence: 120000n,
        lastKnownRemainAmountPence: 120000n,
        lastKnownStatus: 'UNPAID',
        lastKnownPaymentCycleType: 'MONTHLY',
        lastSyncedAt: new Date('2026-03-15T00:00:00Z'),
      },
    });
    return { caseId: c.id, chargeId: ch.id };
  }

  it('updates a paid charge to PAID and closes the case (LWCA dropped it from the arrears list)', async () => {
    const { caseId, chargeId } = await seedActiveUnpaidCharge('inv-paid');

    const lwca: LwcaInvoiceClient = {
      listArrears: () => Promise.resolve([]), // payment happened — invoice no longer in arrears
      listAllRaw: () => Promise.resolve([]),
      probe: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 0 }),
      getInvoice: async (_org, id) => {
        expect(id).toBe('inv-paid');
        return {
          id: 'inv-paid',
          organisationId: ORG_ID,
          grossAmount: 120000,
          remainAmount: 0,
          dueDate: '2026-03-01',
          invoiceDate: '2026-02-15',
          status: 'PAID',
          paymentCycleType: 'MONTHLY',
          tenancyId: 'stale-tenancy-1',
          lineItems: [{ type: 'Rent' }],
        };
      },
    };

    const result = await makeJobWithStub(lwca).runForOrg(ORG_ID);
    expect(result.casesClosed).toBe(1);

    const refreshed = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(refreshed.lastKnownStatus).toBe('PAID');
    expect(refreshed.lastKnownRemainAmountPence).toBe(0n);
    // Stage moves to RESOLVED so stage-severity comparisons stop
    // treating this row as live arrears.
    expect(refreshed.currentStage).toBe('RESOLVED');
    expect(refreshed.currentStageEnteredAt).not.toBeNull();

    const closed = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(closed.status).toBe('CLOSED');

    const fullyPaidEvents = await prisma.caseEvent.findMany({
      where: { caseId, kind: 'CHARGE_FULLY_PAID' },
    });
    expect(fullyPaidEvents).toHaveLength(1);
  });

  it('marks a charge DELETED locally when the invoice 404s upstream', async () => {
    const { caseId, chargeId } = await seedActiveUnpaidCharge('inv-deleted');

    const lwca: LwcaInvoiceClient = {
      listArrears: () => Promise.resolve([]),
      listAllRaw: () => Promise.resolve([]),
      probe: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 0 }),
      getInvoice: async () => null, // 404
    };

    await makeJobWithStub(lwca).runForOrg(ORG_ID);

    const refreshed = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(refreshed.lastKnownStatus).toBe('DELETED');
    expect(refreshed.currentStage).toBe('RESOLVED');

    // Case-close happens because every remaining charge is in a final
    // state (DELETED) and the balance recomputes to 0.
    const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(c.status).toBe('CLOSED');
  });

  it('leaves charges alone when they are still in the arrears list', async () => {
    const { chargeId } = await seedActiveUnpaidCharge('inv-still-arrears');

    let getInvoiceCalls = 0;
    const lwca: LwcaInvoiceClient = {
      listArrears: () =>
        Promise.resolve([
          {
            charge: {
              organisationId: ORG_ID,
              lwcaInvoiceId: 'inv-still-arrears',
              dueDate: new Date('2026-03-01T00:00:00Z'),
              invoiceDate: new Date('2026-02-15T00:00:00Z'),
              grossAmountPence: 120000n,
              lastKnownRemainAmountPence: 120000n,
              lastKnownStatus: 'UNPAID',
              lastKnownPaymentCycleType: 'MONTHLY',
              lastKnownType: null,
              lastKnownDescription: null,
              lastSyncedAt: new Date(),
              upstreamReferenceId: null,
            },
            tenancy: {
              tenancyId: 'stale-tenancy-1',
              propertyId: 'stale-prop',
              propertyName: null,
              propertyAddress1: null,
              propertyAddress2: null,
            },
          },
        ]),
      listAllRaw: () => Promise.resolve([]),
      probe: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 0 }),
      getInvoice: () => {
        getInvoiceCalls++;
        return Promise.resolve(null);
      },
    };

    await makeJobWithStub(lwca).runForOrg(ORG_ID);

    // The charge was in the list, so stale-refresh shouldn't have
    // touched it at all.
    expect(getInvoiceCalls).toBe(0);

    const c = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(c.lastKnownStatus).toBe('UNPAID');
  });
});
