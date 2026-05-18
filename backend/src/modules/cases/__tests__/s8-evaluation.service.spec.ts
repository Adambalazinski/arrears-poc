import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { S8EvaluationService } from '../s8-evaluation.service';
import { DEFAULT_ORG_CONFIG } from '../../organisations/defaults';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 's8-test-org';
const TENANCY_ID = 'tenancy-s8-test';
const RENT_PENCE = 120000n; // £1200/month — month=£3600, weeks=£3900, threshold=£3600

async function clearAll(): Promise<void> {
  await prisma.escalationFlag.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisationConfig.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisation.deleteMany({ where: { id: ORG_ID } });
}

beforeAll(async () => {
  await prisma.$connect();
  await clearAll();
  await prisma.organisation.create({
    data: {
      id: ORG_ID,
      name: 'S8 test org',
      config: { create: { ...DEFAULT_ORG_CONFIG } },
    },
  });
});

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.tenancy.upsert({
    where: { id: TENANCY_ID },
    update: {},
    create: {
      id: TENANCY_ID,
      organisationId: ORG_ID,
      propertyId: 'prop-s8',
      status: 'ACTIVE',
      rentAmountPence: RENT_PENCE,
      lastSyncedAt: new Date(),
    },
  });
});

afterEach(async () => {
  await prisma.escalationFlag.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
});

function makeService(): S8EvaluationService {
  return new S8EvaluationService(prisma as unknown as PrismaService);
}

async function createCase(opts: {
  breathingSpaceActive?: boolean;
  s8Eligible?: boolean;
  charges: bigint[];
}): Promise<string> {
  const created = await prisma.case.create({
    data: {
      organisationId: ORG_ID,
      tenancyId: TENANCY_ID,
      status: 'ACTIVE',
      openedAt: new Date(),
      lastKnownBalancePence: opts.charges.reduce((a, b) => a + b, 0n),
      lastKnownBalanceAt: new Date(),
      breathingSpaceActive: opts.breathingSpaceActive ?? false,
      s8Eligible: opts.s8Eligible ?? false,
    },
  });
  for (let i = 0; i < opts.charges.length; i++) {
    await prisma.charge.create({
      data: {
        caseId: created.id,
        organisationId: ORG_ID,
        lwcaInvoiceId: `${created.id}-c-${i}`,
        dueDate: new Date('2026-01-01T00:00:00Z'),
        invoiceDate: new Date('2025-12-15T00:00:00Z'),
        grossAmountPence: opts.charges[i]!,
        lastKnownRemainAmountPence: opts.charges[i]!,
        lastKnownStatus: 'UNPAID',
        lastSyncedAt: new Date(),
      },
    });
  }
  return created.id;
}

describe('S8EvaluationService', () => {
  describe('R6.1 — threshold math', () => {
    it('not eligible when balance is below the lesser of months/weeks rent', async () => {
      // £3200 < min(£3600 months, £3900 weeks) = £3600
      const caseId = await createCase({ charges: [120000n, 80000n, 120000n] });
      const r = await makeService().evaluate(caseId);
      expect(r.eligible).toBe(false);
      expect(r.balancePence).toBe(320000n);
      expect(r.thresholdPence).toBe(360000n);
      expect(r.transition).toBe('NONE');
    });

    it('eligible when balance equals the threshold (R6.1 uses >=)', async () => {
      // £3600 == months threshold of £3600
      const caseId = await createCase({ charges: [120000n, 120000n, 120000n] });
      const r = await makeService().evaluate(caseId);
      expect(r.eligible).toBe(true);
      expect(r.balancePence).toBe(360000n);
      expect(r.thresholdPence).toBe(360000n);
      expect(r.transition).toBe('RAISED');
    });

    it('uses min(months, weeks): smaller weeks formula governs when configured that way', async () => {
      // Override config so weeks threshold becomes the binding one.
      // monthsThreshold=4 -> months=£4800; weeksThreshold=13 -> weeks=£3900.
      // min = £3900.
      await prisma.organisationConfig.update({
        where: { organisationId: ORG_ID },
        data: { s8RentMonthsThreshold: 4 },
      });
      const caseId = await createCase({ charges: [200000n, 200000n] }); // £4000
      const r = await makeService().evaluate(caseId);
      expect(r.thresholdPence).toBe(390000n); // £3900 weeks
      expect(r.eligible).toBe(true);

      // Restore config for sibling tests.
      await prisma.organisationConfig.update({
        where: { organisationId: ORG_ID },
        data: { s8RentMonthsThreshold: DEFAULT_ORG_CONFIG.s8RentMonthsThreshold },
      });
    });

    it('skips evaluation when tenancy.rentAmountPence is null (cannot compute threshold)', async () => {
      await prisma.tenancy.update({
        where: { id: TENANCY_ID },
        data: { rentAmountPence: null },
      });
      const caseId = await createCase({ charges: [1000000n] }); // £10,000
      const r = await makeService().evaluate(caseId);
      expect(r.thresholdPence).toBeNull();
      expect(r.eligible).toBe(false);
      expect(r.transition).toBe('NONE');
    });
  });

  describe('R6.2 — FALSE → TRUE raises flag + event', () => {
    it('sets s8Eligible=true, creates an open EscalationFlag, emits S8_ELIGIBILITY_RAISED', async () => {
      const caseId = await createCase({ charges: [400000n] }); // £4000 > £3600
      const r = await makeService().evaluate(caseId);
      expect(r.transition).toBe('RAISED');

      const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(c.s8Eligible).toBe(true);

      const flags = await prisma.escalationFlag.findMany({
        where: { caseId, kind: 'S8_ELIGIBLE' },
      });
      expect(flags).toHaveLength(1);
      expect(flags[0]!.resolvedAt).toBeNull();
      expect(flags[0]!.raisedReason).toContain('meets threshold');

      const events = await prisma.caseEvent.findMany({
        where: { caseId, kind: 'S8_ELIGIBILITY_RAISED' },
      });
      expect(events).toHaveLength(1);
    });

    it('does nothing on a second evaluation when state is unchanged', async () => {
      const caseId = await createCase({ charges: [400000n] });
      await makeService().evaluate(caseId);
      const r2 = await makeService().evaluate(caseId);
      expect(r2.transition).toBe('NONE');

      // Still exactly one flag and one event.
      const flags = await prisma.escalationFlag.count({
        where: { caseId, kind: 'S8_ELIGIBLE' },
      });
      const events = await prisma.caseEvent.count({
        where: { caseId, kind: 'S8_ELIGIBILITY_RAISED' },
      });
      expect(flags).toBe(1);
      expect(events).toBe(1);
    });
  });

  describe('R6.3 — TRUE → FALSE resolves flag + emits rescinded', () => {
    it('resolves the open flag, sets s8Eligible=false, emits S8_ELIGIBILITY_RESCINDED', async () => {
      // Start eligible (raise) then drop balance below threshold and re-evaluate.
      const caseId = await createCase({ charges: [400000n] });
      await makeService().evaluate(caseId);

      // Pay off enough to drop below threshold.
      await prisma.charge.updateMany({
        where: { caseId },
        data: { lastKnownRemainAmountPence: 100000n, lastKnownStatus: 'PARTIALLY_PAID' },
      });
      const r = await makeService().evaluate(caseId);
      expect(r.transition).toBe('RESCINDED');

      const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(c.s8Eligible).toBe(false);

      const flag = await prisma.escalationFlag.findFirstOrThrow({
        where: { caseId, kind: 'S8_ELIGIBLE' },
      });
      expect(flag.resolvedAt).not.toBeNull();
      expect(flag.resolvedReason).toContain('below threshold');

      const events = await prisma.caseEvent.findMany({
        where: { caseId, kind: 'S8_ELIGIBILITY_RESCINDED' },
      });
      expect(events).toHaveLength(1);
    });
  });

  describe('R6.4 — yo-yo: re-raised on next transition', () => {
    it('raises a new flag after a previous rescind', async () => {
      const caseId = await createCase({ charges: [400000n] });
      await makeService().evaluate(caseId); // raise
      await prisma.charge.updateMany({
        where: { caseId },
        data: { lastKnownRemainAmountPence: 100000n },
      });
      await makeService().evaluate(caseId); // rescind
      await prisma.charge.updateMany({
        where: { caseId },
        data: { lastKnownRemainAmountPence: 400000n },
      });
      const r = await makeService().evaluate(caseId); // raise again
      expect(r.transition).toBe('RAISED');

      const openFlags = await prisma.escalationFlag.findMany({
        where: { caseId, kind: 'S8_ELIGIBLE', resolvedAt: null },
      });
      expect(openFlags).toHaveLength(1);

      const allFlags = await prisma.escalationFlag.count({
        where: { caseId, kind: 'S8_ELIGIBLE' },
      });
      expect(allFlags).toBe(2); // one resolved + one open
    });
  });

  describe('R6.6 — breathing space suppresses S8', () => {
    it('forces eligibility to false even when balance is over threshold', async () => {
      const caseId = await createCase({
        breathingSpaceActive: true,
        charges: [400000n],
      });
      const r = await makeService().evaluate(caseId);
      expect(r.eligible).toBe(false);
      expect(r.transition).toBe('NONE');

      const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(c.s8Eligible).toBe(false);

      const flags = await prisma.escalationFlag.count({
        where: { caseId, kind: 'S8_ELIGIBLE' },
      });
      expect(flags).toBe(0);
    });

    it('rescinds an already-raised flag when breathing space activates after the fact', async () => {
      const caseId = await createCase({ charges: [400000n] });
      await makeService().evaluate(caseId); // raise
      await prisma.case.update({
        where: { id: caseId },
        data: { breathingSpaceActive: true },
      });
      const r = await makeService().evaluate(caseId);
      expect(r.transition).toBe('RESCINDED');
      expect(r.reason).toBe('breathing space active');

      const open = await prisma.escalationFlag.count({
        where: { caseId, kind: 'S8_ELIGIBLE', resolvedAt: null },
      });
      expect(open).toBe(0);
    });
  });

  describe('skip conditions', () => {
    it('skips when case is not ACTIVE', async () => {
      const caseId = await createCase({ charges: [400000n] });
      await prisma.case.update({
        where: { id: caseId },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      const r = await makeService().evaluate(caseId);
      expect(r.transition).toBe('SKIPPED');
    });
  });
});
