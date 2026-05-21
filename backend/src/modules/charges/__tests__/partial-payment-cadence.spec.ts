/**
 * R8.2 — Partial-payment chase-stage logic (post-MVP slice).
 *
 *   - ≥90% cumulative paid → reset cadence: cycle++, anchor=now,
 *     currentStage=NOT_DUE, 3-WD grace before next chase.
 *   - <90% paid           → step back one stage: cycle++, anchor =
 *     now − target stage's WD working days, currentStage=NOT_DUE.
 *   - At WD3 floor        → record CHARGE_PARTIALLY_PAID only,
 *     no cadence change.
 *   - NOT_DUE / RESOLVED  → record CHARGE_PARTIALLY_PAID only,
 *     no cadence change.
 *
 * The cycle bump lets ChaseScheduleEntry's unique index
 * (chargeId, cadenceCycle, stage, recipientRole) admit a fresh entry
 * at the same stage in the new cycle without colliding with the old
 * one.
 */
import { CaseEventKind, ChaseStage, PrismaClient, Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BankHolidaysLoader } from '../../../common/working-day/bank-holidays.loader';
import type { GovUkBankHolidays } from '../../../common/working-day/types';
import { WorkingDayService } from '../../../common/working-day/working-day.service';
import type { LwcaChargeUpsert } from '../../../integrations/lwca/lwca-invoice.mapper';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';
import { DEFAULT_ORG_CONFIG } from '../../organisations/defaults';
import { ChargesService } from '../charges.service';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 'r82-test-org';
const TENANCY_ID = 'r82-test-tenancy';
const LWCA_ID = 'r82-inv-1';

const EMPTY_CALENDAR: GovUkBankHolidays = {
  'england-and-wales': { division: 'england-and-wales', events: [] },
};

function makeWorkingDay(): WorkingDayService {
  const svc = new WorkingDayService({} as BankHolidaysLoader);
  svc.applyCalendar(EMPTY_CALENDAR);
  return svc;
}

function makeService(): ChargesService {
  return new ChargesService(prisma as unknown as PrismaService, makeWorkingDay());
}

async function wipeOrg(): Promise<void> {
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
  await wipeOrg();
  await prisma.organisation.create({
    data: {
      id: ORG_ID,
      name: 'R8.2 test',
      config: { create: DEFAULT_ORG_CONFIG },
    },
  });
  await prisma.tenancy.create({
    data: {
      id: TENANCY_ID,
      organisationId: ORG_ID,
      propertyId: 'r82-prop-1',
      propertyName: '1 Test Street',
      status: 'ACTIVE',
      lastSyncedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await wipeOrg();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.chaseScheduleEntry.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
});

afterEach(async () => {
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.chaseScheduleEntry.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
});

/** Seed an ACTIVE case + one charge at the given initial state. */
async function seed(opts: {
  grossPence: bigint;
  remainPence: bigint;
  stage: ChaseStage;
  cycle?: number;
}): Promise<{ caseId: string; chargeId: string }> {
  const c = await prisma.case.create({
    data: {
      organisationId: ORG_ID,
      tenancyId: TENANCY_ID,
      status: 'ACTIVE',
      openedAt: new Date(),
      lastKnownBalancePence: opts.remainPence,
      lastKnownBalanceAt: new Date(),
    },
  });
  const charge = await prisma.charge.create({
    data: {
      caseId: c.id,
      organisationId: ORG_ID,
      lwcaInvoiceId: LWCA_ID,
      dueDate: new Date('2026-04-01T00:00:00Z'),
      invoiceDate: new Date('2026-03-15T00:00:00Z'),
      grossAmountPence: opts.grossPence,
      lastKnownRemainAmountPence: opts.remainPence,
      lastKnownStatus: 'UNPAID',
      lastKnownPaymentCycleType: 'MONTHLY',
      lastSyncedAt: new Date(),
      currentStage: opts.stage,
      cadenceCycle: opts.cycle ?? 0,
    },
  });
  return { caseId: c.id, chargeId: charge.id };
}

function lwcaUpsert(remainPence: bigint, overrides: Partial<LwcaChargeUpsert> = {}): LwcaChargeUpsert {
  return {
    organisationId: ORG_ID,
    lwcaInvoiceId: LWCA_ID,
    dueDate: new Date('2026-04-01T00:00:00Z'),
    invoiceDate: new Date('2026-03-15T00:00:00Z'),
    grossAmountPence: 120000n,
    lastKnownRemainAmountPence: remainPence,
    lastKnownStatus: 'PARTIALLY_PAID',
    lastKnownPaymentCycleType: 'MONTHLY',
    lastKnownType: null,
    lastKnownDescription: null,
    lastSyncedAt: new Date(),
    upstreamReferenceId: null,
    ...overrides,
  };
}

describe('R8.1 — partial-payment event', () => {
  it('emits CHARGE_PARTIALLY_PAID when remain decreases on an arrears-status charge', async () => {
    const { caseId } = await seed({
      grossPence: 120000n,
      remainPence: 120000n,
      stage: ChaseStage.AWAITING_WD5,
    });
    await makeService().upsertFromLwca(caseId, lwcaUpsert(80000n));

    const events = await prisma.caseEvent.findMany({
      where: { caseId, kind: CaseEventKind.CHARGE_PARTIALLY_PAID },
    });
    expect(events).toHaveLength(1);
    const payload = events[0]!.payloadJson as Prisma.JsonObject;
    expect(payload.deltaPence).toBe('40000');
    expect(payload.paidPence).toBe('40000');
    expect(payload.remainPence).toBe('80000');
  });

  it('emits no event on a no-op resync with identical remain', async () => {
    const { caseId } = await seed({
      grossPence: 120000n,
      remainPence: 80000n,
      stage: ChaseStage.WD5_SENT,
    });
    await makeService().upsertFromLwca(caseId, lwcaUpsert(80000n));

    const events = await prisma.caseEvent.findMany({
      where: { caseId, kind: CaseEventKind.CHARGE_PARTIALLY_PAID },
    });
    expect(events).toHaveLength(0);
  });
});

describe('R8.2 — cumulative paid ≥ 90%: reset to WD3 (with grace)', () => {
  it('bumps cycle, sets anchor=now, currentStage=NOT_DUE; emits CHARGE_CADENCE_RESET', async () => {
    const before = Date.now();
    const { caseId, chargeId } = await seed({
      grossPence: 100000n, // £1000.00 gross
      remainPence: 100000n,
      stage: ChaseStage.WD14_NOTIFIED, // at the top — reset should still drop to NOT_DUE
    });
    await makeService().upsertFromLwca(caseId, lwcaUpsert(5000n, { grossAmountPence: 100000n })); // 95% paid

    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(charge.cadenceCycle).toBe(1);
    expect(charge.currentStage).toBe(ChaseStage.NOT_DUE);
    expect(charge.cadenceAnchorAt).toBeInstanceOf(Date);
    expect(charge.cadenceAnchorAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(charge.stageResetAt).toBeInstanceOf(Date);

    const resetEvents = await prisma.caseEvent.findMany({
      where: { caseId, kind: CaseEventKind.CHARGE_CADENCE_RESET },
    });
    expect(resetEvents).toHaveLength(1);
    const payload = resetEvents[0]!.payloadJson as Prisma.JsonObject;
    expect(payload.previousStage).toBe(ChaseStage.WD14_NOTIFIED);
    expect(payload.newCycle).toBe(1);
  });
});

describe('R8.2 — cumulative paid < 90%: step back one stage', () => {
  it('from AWAITING_WD8 → AWAITING_WD5 target; anchor placed 5 WD ago; cycle bumps', async () => {
    const { caseId, chargeId } = await seed({
      grossPence: 120000n,
      remainPence: 120000n,
      stage: ChaseStage.AWAITING_WD8,
    });
    await makeService().upsertFromLwca(caseId, lwcaUpsert(80000n)); // 33% paid

    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(charge.cadenceCycle).toBe(1);
    expect(charge.currentStage).toBe(ChaseStage.NOT_DUE);
    expect(charge.cadenceAnchorAt).toBeInstanceOf(Date);
    expect(charge.stageSteppedBackAt).toBeInstanceOf(Date);

    // Anchor should be 5 calendar weekdays (config.chaseDaySecond=5) in the
    // past; allow a generous window for test timing variance.
    const ageMs = Date.now() - charge.cadenceAnchorAt!.getTime();
    const ageDays = ageMs / 86_400_000;
    expect(ageDays).toBeGreaterThanOrEqual(4.9);
    expect(ageDays).toBeLessThan(10); // safe upper bound; weekends can pad

    const events = await prisma.caseEvent.findMany({
      where: { caseId, kind: CaseEventKind.CHARGE_CADENCE_STEPPED_BACK },
    });
    expect(events).toHaveLength(1);
    const payload = events[0]!.payloadJson as Prisma.JsonObject;
    expect(payload.previousStage).toBe(ChaseStage.AWAITING_WD8);
    expect(payload.targetStage).toBe(ChaseStage.AWAITING_WD5);
  });

  it('from WD14_NOTIFIED steps back to AWAITING_WD8', async () => {
    const { caseId, chargeId } = await seed({
      grossPence: 120000n,
      remainPence: 120000n,
      stage: ChaseStage.WD14_NOTIFIED,
    });
    await makeService().upsertFromLwca(caseId, lwcaUpsert(60000n)); // 50% paid

    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(charge.cadenceCycle).toBe(1);
    expect(charge.cadenceAnchorAt).toBeInstanceOf(Date);

    const events = await prisma.caseEvent.findMany({
      where: { caseId, kind: CaseEventKind.CHARGE_CADENCE_STEPPED_BACK },
    });
    expect(events[0]!.payloadJson as Prisma.JsonObject).toMatchObject({
      targetStage: ChaseStage.AWAITING_WD8,
    });
  });
});

describe('R8.2 — at the WD3 floor: no cadence change', () => {
  it.each([
    ['AWAITING_WD3', ChaseStage.AWAITING_WD3],
    ['WD3_SENT', ChaseStage.WD3_SENT],
  ])('from %s, partial payment is recorded but cadence stays put', async (_name, stage) => {
    const { caseId, chargeId } = await seed({
      grossPence: 120000n,
      remainPence: 120000n,
      stage,
    });
    await makeService().upsertFromLwca(caseId, lwcaUpsert(80000n)); // 33% paid

    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(charge.cadenceCycle).toBe(0); // unchanged
    expect(charge.cadenceAnchorAt).toBeNull(); // never set
    expect(charge.currentStage).toBe(stage); // unchanged

    const partial = await prisma.caseEvent.findMany({
      where: { caseId, kind: CaseEventKind.CHARGE_PARTIALLY_PAID },
    });
    expect(partial).toHaveLength(1);

    const reset = await prisma.caseEvent.findMany({
      where: { caseId, kind: CaseEventKind.CHARGE_CADENCE_RESET },
    });
    expect(reset).toHaveLength(0);

    const stepBack = await prisma.caseEvent.findMany({
      where: { caseId, kind: CaseEventKind.CHARGE_CADENCE_STEPPED_BACK },
    });
    expect(stepBack).toHaveLength(0);
  });
});

describe('R8.2 — NOT_DUE charge: partial payment recorded, no cadence change', () => {
  it('records CHARGE_PARTIALLY_PAID but leaves cadence untouched', async () => {
    const { caseId, chargeId } = await seed({
      grossPence: 120000n,
      remainPence: 120000n,
      stage: ChaseStage.NOT_DUE,
    });
    await makeService().upsertFromLwca(caseId, lwcaUpsert(80000n));

    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(charge.cadenceCycle).toBe(0);
    expect(charge.cadenceAnchorAt).toBeNull();
    expect(charge.currentStage).toBe(ChaseStage.NOT_DUE);

    const partial = await prisma.caseEvent.findMany({
      where: { caseId, kind: CaseEventKind.CHARGE_PARTIALLY_PAID },
    });
    expect(partial).toHaveLength(1);
  });
});
