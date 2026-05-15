import { PrismaClient, type Charge } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clock } from '../../../common/clock/clock.service';
import { BankHolidaysLoader } from '../../../common/working-day/bank-holidays.loader';
import { WorkingDayService } from '../../../common/working-day/working-day.service';
import type { GovUkBankHolidays } from '../../../common/working-day/types';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';
import { DEFAULT_ORG_CONFIG } from '../../organisations/defaults';
import { ChaseTickService } from '../chase-tick.service';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 'chase-tick-test-org';
const TENANCY_ID = 'chase-tick-tenancy-1';

const FIXTURE_CALENDAR: GovUkBankHolidays = {
  'england-and-wales': {
    division: 'england-and-wales',
    events: [
      { title: "New Year's Day", date: '2026-01-01', notes: '', bunting: true },
      { title: 'Good Friday', date: '2026-04-03', notes: '', bunting: false },
      { title: 'Easter Monday', date: '2026-04-06', notes: '', bunting: true },
      { title: 'Early May bank holiday', date: '2026-05-04', notes: '', bunting: true },
      { title: 'Spring bank holiday', date: '2026-05-25', notes: '', bunting: true },
    ],
  },
};

function makeWorkingDay(): WorkingDayService {
  const svc = new WorkingDayService({} as BankHolidaysLoader);
  svc.applyCalendar(FIXTURE_CALENDAR);
  return svc;
}

function makeService(): ChaseTickService {
  const clock = new Clock();
  return new ChaseTickService(prisma as unknown as PrismaService, makeWorkingDay(), clock);
}

async function wipe(): Promise<void> {
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.chaseScheduleEntry.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
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
  await prisma.organisation.create({ data: { id: ORG_ID, name: 'Chase tick test' } });
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
      status: 'ACTIVE',
      lastSyncedAt: new Date(),
    },
  });
});

afterEach(async () => {
  await wipe();
});

async function makeCase(opts: { breathingSpaceActive?: boolean } = {}): Promise<string> {
  const row = await prisma.case.create({
    data: {
      organisationId: ORG_ID,
      tenancyId: TENANCY_ID,
      status: 'ACTIVE',
      openedAt: new Date(),
      lastKnownBalancePence: 0n,
      lastKnownBalanceAt: new Date(),
      breathingSpaceActive: opts.breathingSpaceActive ?? false,
    },
  });
  return row.id;
}

async function makeCharge(
  caseId: string,
  lwcaId: string,
  dueDate: Date,
  status: Charge['lastKnownStatus'] = 'UNPAID',
): Promise<Charge> {
  return prisma.charge.create({
    data: {
      caseId,
      organisationId: ORG_ID,
      lwcaInvoiceId: lwcaId,
      dueDate,
      invoiceDate: new Date(dueDate.getTime() - 14 * 86400_000),
      grossAmountPence: 120_000n,
      lastKnownRemainAmountPence: 120_000n,
      lastKnownStatus: status,
      lastSyncedAt: new Date(),
    },
  });
}

const NOW = new Date('2026-05-15T10:00:00Z'); // Fri 15 May 2026

describe('ChaseTickService', () => {
  it('creates AWAITING_WD3 entry once the threshold is crossed', async () => {
    const caseId = await makeCase();
    const charge = await makeCharge(caseId, 'inv-wd3', new Date('2026-05-12T00:00:00Z')); // Tue → WD3 by Fri

    const r = await makeService().runTick(NOW);
    expect(r.scanned).toBe(1);
    expect(r.entriesCreated).toBe(1);
    expect(r.entriesSkipped).toBe(0);
    expect(r.stagesAdvanced).toBe(1);

    const entries = await prisma.chaseScheduleEntry.findMany({
      where: { chargeId: charge.id },
    });
    expect(entries.map((e) => e.stage)).toEqual(['AWAITING_WD3']);
    expect(entries[0]!.firedAt).toBeNull();

    const updated = await prisma.charge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(updated.currentStage).toBe('AWAITING_WD3');
    expect(updated.workingDaysOverdue).toBe(3);
  });

  it('creates entries for every threshold crossed in a single tick', async () => {
    const caseId = await makeCase();
    // dueDate 4 weeks before NOW so WD14 + WD8 + WD5 + WD3 are all crossed
    const charge = await makeCharge(caseId, 'inv-wd14', new Date('2026-04-13T00:00:00Z'));

    await makeService().runTick(NOW);

    const entries = await prisma.chaseScheduleEntry.findMany({
      where: { chargeId: charge.id },
      orderBy: { stage: 'asc' },
    });
    expect(entries.map((e) => e.stage).sort()).toEqual([
      'AWAITING_WD14',
      'AWAITING_WD3',
      'AWAITING_WD5',
      'AWAITING_WD8',
    ]);
    // Charge stage advances to the most severe AWAITING_*
    const updated = await prisma.charge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(updated.currentStage).toBe('AWAITING_WD14');
  });

  it('is idempotent: a second tick at the same WD doesn\'t create duplicates', async () => {
    const caseId = await makeCase();
    const charge = await makeCharge(caseId, 'inv-idem', new Date('2026-05-12T00:00:00Z'));
    const svc = makeService();
    await svc.runTick(NOW);
    const r2 = await svc.runTick(NOW);
    expect(r2.entriesCreated).toBe(0);
    const entries = await prisma.chaseScheduleEntry.findMany({
      where: { chargeId: charge.id },
    });
    expect(entries).toHaveLength(1);
  });

  it('R4.5 breathing space: new entries are created with skippedReason=BREATHING_SPACE_ACTIVE', async () => {
    const caseId = await makeCase({ breathingSpaceActive: true });
    const charge = await makeCharge(caseId, 'inv-bs', new Date('2026-05-12T00:00:00Z'));

    const r = await makeService().runTick(NOW);
    expect(r.entriesCreated).toBe(0);
    expect(r.entriesSkipped).toBe(1);
    const entries = await prisma.chaseScheduleEntry.findMany({
      where: { chargeId: charge.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.skippedReason).toBe('BREATHING_SPACE_ACTIVE');
    expect(entries[0]!.firedAt).not.toBeNull(); // marked done at creation
  });

  it('ignores charges in final states (PAID / RECONCILED / DELETED)', async () => {
    const caseId = await makeCase();
    await makeCharge(caseId, 'inv-paid', new Date('2026-05-12T00:00:00Z'), 'PAID');
    await makeCharge(caseId, 'inv-reconciled', new Date('2026-05-12T00:00:00Z'), 'RECONCILED');
    await makeCharge(caseId, 'inv-deleted', new Date('2026-05-12T00:00:00Z'), 'DELETED');

    const r = await makeService().runTick(NOW);
    expect(r.scanned).toBe(0);
    expect(r.entriesCreated).toBe(0);
  });

  it('ignores charges on CLOSED cases', async () => {
    const caseId = await makeCase();
    await makeCharge(caseId, 'inv-closed', new Date('2026-05-12T00:00:00Z'));
    await prisma.case.update({
      where: { id: caseId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    const r = await makeService().runTick(NOW);
    expect(r.scanned).toBe(0);
  });

  it('respects per-org config overrides for thresholds', async () => {
    await prisma.organisationConfig.update({
      where: { organisationId: ORG_ID },
      data: { chaseDayFirst: 1, chaseDaySecond: 2 },
    });
    const caseId = await makeCase();
    const charge = await makeCharge(caseId, 'inv-override', new Date('2026-05-13T00:00:00Z')); // Wed -> WD2 by Fri

    await makeService().runTick(NOW);
    const entries = await prisma.chaseScheduleEntry.findMany({
      where: { chargeId: charge.id },
      orderBy: { stage: 'asc' },
    });
    expect(entries.map((e) => e.stage).sort()).toEqual(['AWAITING_WD3', 'AWAITING_WD5']);
  });

  it('emits CHASE_STAGE_ADVANCED on stage transition', async () => {
    const caseId = await makeCase();
    const charge = await makeCharge(caseId, 'inv-evt', new Date('2026-05-12T00:00:00Z'));
    await makeService().runTick(NOW);
    const events = await prisma.caseEvent.findMany({
      where: { caseId, kind: 'CHASE_STAGE_ADVANCED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payloadJson).toMatchObject({
      chargeId: charge.id,
      fromStage: 'NOT_DUE',
      toStage: 'AWAITING_WD3',
      workingDaysOverdue: 3,
    });
  });

  it('logs and skips charges whose org has no config row', async () => {
    const caseId = await makeCase();
    const charge = await makeCharge(caseId, 'inv-no-config', new Date('2026-05-12T00:00:00Z'));
    // Drop the config row
    await prisma.organisationConfig.delete({ where: { organisationId: ORG_ID } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await makeService().runTick(NOW);
    expect(r.scanned).toBe(1);
    expect(r.entriesCreated).toBe(0);
    const entries = await prisma.chaseScheduleEntry.findMany({
      where: { chargeId: charge.id },
    });
    expect(entries).toEqual([]);
    warn.mockRestore();
  });
});
