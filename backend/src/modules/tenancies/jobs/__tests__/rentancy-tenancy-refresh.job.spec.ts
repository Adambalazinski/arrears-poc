import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixtureRentancyClient } from '../../../../integrations/rentancy/fixture-rentancy.client';
import type { PrismaService } from '../../../../integrations/prisma/prisma.service';
import { TenancyRefreshService } from '../../tenancy-refresh.service';
import { RentancyTenancyRefreshJob } from '../rentancy-tenancy-refresh.job';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';
const RENTANCY_FIXTURE_DIR = '../fixtures/rentancy';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 'rentancy-refresh-job-test';

async function wipe(): Promise<void> {
  await prisma.syncJobRun.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancyContact.deleteMany({
    where: { tenancy: { organisationId: ORG_ID } },
  });
  await prisma.contact.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisation.deleteMany({ where: { id: ORG_ID } });
}

beforeAll(async () => {
  await prisma.$connect();
  await wipe();
  await prisma.organisation.create({ data: { id: ORG_ID, name: 'Hourly refresh test' } });
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.syncJobRun.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancyContact.deleteMany({
    where: { tenancy: { organisationId: ORG_ID } },
  });
  await prisma.contact.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
});

afterEach(async () => {
  await prisma.syncJobRun.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancyContact.deleteMany({
    where: { tenancy: { organisationId: ORG_ID } },
  });
  await prisma.contact.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
});

function makeJob(): RentancyTenancyRefreshJob {
  const refresh = new TenancyRefreshService(
    prisma as unknown as PrismaService,
    new FixtureRentancyClient(RENTANCY_FIXTURE_DIR),
  );
  return new RentancyTenancyRefreshJob(prisma as unknown as PrismaService, refresh);
}

async function seedActiveCaseAndStubTenancy(tenancyId: string): Promise<void> {
  await prisma.tenancy.create({
    data: {
      id: tenancyId,
      organisationId: ORG_ID,
      propertyId: 'prop-stub',
      status: 'UNKNOWN',
      lastSyncedAt: new Date(),
    },
  });
  await prisma.case.create({
    data: {
      organisationId: ORG_ID,
      tenancyId,
      status: 'ACTIVE',
      openedAt: new Date(),
      lastKnownBalancePence: 0n,
      lastKnownBalanceAt: new Date(),
    },
  });
}

describe('RentancyTenancyRefreshJob.runForAllActive', () => {
  it('refreshes every active-case tenancy and writes a per-org SyncJobRun', async () => {
    await seedActiveCaseAndStubTenancy('tenancy-abc-001');
    await seedActiveCaseAndStubTenancy('tenancy-xyz-002');

    const job = makeJob();
    const result = await job.runForAllActive();
    expect(result.refreshed).toBe(2);
    expect(result.notFound).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.organisations).toBe(1);

    const abc = await prisma.tenancy.findUniqueOrThrow({ where: { id: 'tenancy-abc-001' } });
    expect(abc.status).toBe('ACTIVE');
    const xyz = await prisma.tenancy.findUniqueOrThrow({ where: { id: 'tenancy-xyz-002' } });
    expect(xyz.status).toBe('ACTIVE');

    const runs = await prisma.syncJobRun.findMany({
      where: { organisationId: ORG_ID, kind: 'RENTANCY_TENANCY_REFRESH' },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('COMPLETED');
    expect(runs[0]!.itemsProcessed).toBe(2);
    expect(runs[0]!.itemsUpdated).toBe(2);
  });

  it('skips tenancies attached only to CLOSED cases', async () => {
    await prisma.tenancy.create({
      data: {
        id: 'tenancy-abc-001',
        organisationId: ORG_ID,
        propertyId: 'prop-stub',
        status: 'UNKNOWN',
        lastSyncedAt: new Date(),
      },
    });
    await prisma.case.create({
      data: {
        organisationId: ORG_ID,
        tenancyId: 'tenancy-abc-001',
        status: 'CLOSED',
        openedAt: new Date(),
        closedAt: new Date(),
        lastKnownBalancePence: 0n,
        lastKnownBalanceAt: new Date(),
      },
    });
    const job = makeJob();
    const result = await job.runForAllActive();
    expect(result.refreshed).toBe(0);
    expect(result.organisations).toBe(0);
    // No SyncJobRun written because there were no targets.
    expect(await prisma.syncJobRun.count({ where: { organisationId: ORG_ID } })).toBe(0);
  });

  it('records notFound when Rentancy 404s and keeps going for the rest', async () => {
    await seedActiveCaseAndStubTenancy('tenancy-abc-001');
    await seedActiveCaseAndStubTenancy('tenancy-does-not-exist');
    const job = makeJob();
    const result = await job.runForAllActive();
    expect(result.refreshed).toBe(1);
    expect(result.notFound).toBe(1);
    expect(result.failed).toBe(0);

    const abc = await prisma.tenancy.findUniqueOrThrow({ where: { id: 'tenancy-abc-001' } });
    expect(abc.status).toBe('ACTIVE');
  });
});
