import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BreathingSpaceService } from '../breathing-space.service';
import { S8EvaluationService } from '../s8-evaluation.service';
import { DEFAULT_ORG_CONFIG } from '../../organisations/defaults';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 'breathing-space-test-org';
const TENANCY_ID = 'tenancy-bs-test';
const RENT_PENCE = 120000n; // £1200/month — S8 threshold = £3600

async function clearAll(): Promise<void> {
  await prisma.escalationFlag.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.communication.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.chaseScheduleEntry.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
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
      name: 'BS test org',
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
      propertyId: 'prop-bs',
      status: 'ACTIVE',
      rentAmountPence: RENT_PENCE,
      lastSyncedAt: new Date(),
    },
  });
});

afterEach(async () => {
  await prisma.escalationFlag.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.communication.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.chaseScheduleEntry.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
});

function makeService(): BreathingSpaceService {
  const s8 = new S8EvaluationService(prisma as unknown as PrismaService);
  return new BreathingSpaceService(prisma as unknown as PrismaService, s8);
}

async function createCase(opts: {
  s8Eligible?: boolean;
  breathingSpaceActive?: boolean;
  charges?: bigint[];
}): Promise<string> {
  const charges = opts.charges ?? [400000n]; // £4000 — over the S8 threshold
  const created = await prisma.case.create({
    data: {
      organisationId: ORG_ID,
      tenancyId: TENANCY_ID,
      status: 'ACTIVE',
      openedAt: new Date(),
      lastKnownBalancePence: charges.reduce((a, b) => a + b, 0n),
      lastKnownBalanceAt: new Date(),
      breathingSpaceActive: opts.breathingSpaceActive ?? false,
      s8Eligible: opts.s8Eligible ?? false,
    },
  });
  for (let i = 0; i < charges.length; i++) {
    await prisma.charge.create({
      data: {
        caseId: created.id,
        organisationId: ORG_ID,
        lwcaInvoiceId: `${created.id}-c-${i}`,
        dueDate: new Date('2026-01-01T00:00:00Z'),
        invoiceDate: new Date('2025-12-15T00:00:00Z'),
        grossAmountPence: charges[i]!,
        lastKnownRemainAmountPence: charges[i]!,
        lastKnownStatus: 'UNPAID',
        lastSyncedAt: new Date(),
      },
    });
  }
  return created.id;
}

async function createPendingChaseEntry(
  caseId: string,
  recipientRole: 'TENANT' | 'GUARANTOR' = 'TENANT',
): Promise<string> {
  const charge = await prisma.charge.findFirstOrThrow({ where: { caseId } });
  const e = await prisma.chaseScheduleEntry.create({
    data: {
      caseId,
      chargeId: charge.id,
      stage: recipientRole === 'TENANT' ? 'AWAITING_WD3' : 'AWAITING_WD5',
      recipientRole,
      dueAt: new Date(),
    },
  });
  return e.id;
}

async function createPendingDraft(
  caseId: string,
  status: 'AWAITING_APPROVAL' | 'APPROVED',
  recipientRole: 'TENANT' | 'GUARANTOR' = 'TENANT',
) {
  return prisma.communication.create({
    data: {
      organisationId: ORG_ID,
      caseId,
      direction: 'OUTBOUND',
      channel: 'EMAIL',
      recipientRole,
      toAddress:
        recipientRole === 'TENANT' ? 'tenant@example.com' : 'guarantor@example.com',
      subject: 'Reminder',
      bodyMarkdown: 'Hello',
      status,
    },
  });
}

describe('BreathingSpaceService', () => {
  describe('R7.2 — activation cascades', () => {
    it('sets breathingSpaceActive=true and emits BREATHING_SPACE_ACTIVATED', async () => {
      const caseId = await createCase({});
      const r = await makeService().activate({
        caseId,
        source: 'FORMAL_NOTIFICATION',
        note: 'Debt Respite letter received',
      });
      expect(r.changed).toBe(true);
      expect(r.breathingSpaceActive).toBe(true);

      const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(c.breathingSpaceActive).toBe(true);

      const events = await prisma.caseEvent.findMany({
        where: { caseId, kind: 'BREATHING_SPACE_ACTIVATED' },
      });
      expect(events).toHaveLength(1);
    });

    it('raises a BREATHING_SPACE EscalationFlag with the source in payload', async () => {
      const caseId = await createCase({});
      await makeService().activate({
        caseId,
        source: 'TENANT_EMAIL_MENTION',
      });
      const flag = await prisma.escalationFlag.findFirstOrThrow({
        where: { caseId, kind: 'BREATHING_SPACE' },
      });
      expect(flag.resolvedAt).toBeNull();
      const payload = flag.payloadJson as { source: string };
      expect(payload.source).toBe('TENANT_EMAIL_MENTION');
    });

    it('marks pending chase entries skipped with BREATHING_SPACE_ACTIVE', async () => {
      const caseId = await createCase({});
      const entryId = await createPendingChaseEntry(caseId);
      const r = await makeService().activate({ caseId, source: 'FORMAL_NOTIFICATION' });
      expect(r.chaseEntriesSkipped).toBe(1);
      const e = await prisma.chaseScheduleEntry.findUniqueOrThrow({ where: { id: entryId } });
      expect(e.skippedReason).toBe('BREATHING_SPACE_ACTIVE');
      expect(e.firedAt).not.toBeNull();
    });

    it('leaves already-fired chase entries alone', async () => {
      const caseId = await createCase({});
      const entryId = await createPendingChaseEntry(caseId);
      // Pretend this one already fired before breathing space.
      await prisma.chaseScheduleEntry.update({
        where: { id: entryId },
        data: { firedAt: new Date('2026-01-01') },
      });
      await makeService().activate({ caseId, source: 'FORMAL_NOTIFICATION' });
      const e = await prisma.chaseScheduleEntry.findUniqueOrThrow({ where: { id: entryId } });
      expect(e.skippedReason).toBeNull();
      expect(e.firedAt!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('auto-rejects pending OUTBOUND drafts (AWAITING_APPROVAL and APPROVED)', async () => {
      const caseId = await createCase({});
      const a = await createPendingDraft(caseId, 'AWAITING_APPROVAL');
      const b = await createPendingDraft(caseId, 'APPROVED');
      const r = await makeService().activate({ caseId, source: 'FORMAL_NOTIFICATION' });
      expect(r.draftsAutoRejected).toBe(2);

      const updatedA = await prisma.communication.findUniqueOrThrow({ where: { id: a.id } });
      const updatedB = await prisma.communication.findUniqueOrThrow({ where: { id: b.id } });
      expect(updatedA.status).toBe('AUTO_REJECTED');
      expect(updatedA.rejectionReason).toBe('breathing space active');
      expect(updatedB.status).toBe('AUTO_REJECTED');
    });

    it('leaves GUARANTOR-track entries and drafts alive (product choice)', async () => {
      const caseId = await createCase({});
      const tenantEntry = await createPendingChaseEntry(caseId, 'TENANT');
      const guarantorEntry = await createPendingChaseEntry(caseId, 'GUARANTOR');
      const tenantDraft = await createPendingDraft(caseId, 'AWAITING_APPROVAL', 'TENANT');
      const guarantorDraft = await createPendingDraft(caseId, 'AWAITING_APPROVAL', 'GUARANTOR');

      const r = await makeService().activate({ caseId, source: 'FORMAL_NOTIFICATION' });
      expect(r.chaseEntriesSkipped).toBe(1); // tenant only
      expect(r.draftsAutoRejected).toBe(1); // tenant only

      const t = await prisma.chaseScheduleEntry.findUniqueOrThrow({ where: { id: tenantEntry } });
      expect(t.skippedReason).toBe('BREATHING_SPACE_ACTIVE');
      const g = await prisma.chaseScheduleEntry.findUniqueOrThrow({ where: { id: guarantorEntry } });
      expect(g.skippedReason).toBeNull();
      expect(g.firedAt).toBeNull();

      const td = await prisma.communication.findUniqueOrThrow({ where: { id: tenantDraft.id } });
      expect(td.status).toBe('AUTO_REJECTED');
      const gd = await prisma.communication.findUniqueOrThrow({ where: { id: guarantorDraft.id } });
      expect(gd.status).toBe('AWAITING_APPROVAL');
    });

    it('does not touch already-SENT communications', async () => {
      const caseId = await createCase({});
      const sent = await prisma.communication.create({
        data: {
          organisationId: ORG_ID,
          caseId,
          direction: 'OUTBOUND',
          channel: 'EMAIL',
          recipientRole: 'TENANT',
          toAddress: 't@example.com',
          subject: 'Already sent',
          bodyMarkdown: '',
          status: 'SENT',
          sentAt: new Date(),
        },
      });
      await makeService().activate({ caseId, source: 'FORMAL_NOTIFICATION' });
      const after = await prisma.communication.findUniqueOrThrow({ where: { id: sent.id } });
      expect(after.status).toBe('SENT');
    });

    it('R6.6 — clears the S8 flag if it was raised', async () => {
      const caseId = await createCase({}); // £4000 charge → over £3600 threshold
      // First raise S8 by running the evaluator directly.
      const s8 = new S8EvaluationService(prisma as unknown as PrismaService);
      await s8.evaluate(caseId);
      const beforeCase = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(beforeCase.s8Eligible).toBe(true);

      await makeService().activate({ caseId, source: 'FORMAL_NOTIFICATION' });

      const afterCase = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(afterCase.s8Eligible).toBe(false);

      const openS8 = await prisma.escalationFlag.findMany({
        where: { caseId, kind: 'S8_ELIGIBLE', resolvedAt: null },
      });
      expect(openS8).toHaveLength(0);
    });

    it('is idempotent — activating twice returns changed=false on the second call', async () => {
      const caseId = await createCase({});
      const r1 = await makeService().activate({ caseId, source: 'FORMAL_NOTIFICATION' });
      const r2 = await makeService().activate({ caseId, source: 'FORMAL_NOTIFICATION' });
      expect(r1.changed).toBe(true);
      expect(r2.changed).toBe(false);
      const flags = await prisma.escalationFlag.count({
        where: { caseId, kind: 'BREATHING_SPACE' },
      });
      expect(flags).toBe(1);
    });

    it('rejects activation on a CLOSED case', async () => {
      const caseId = await createCase({});
      await prisma.case.update({
        where: { id: caseId },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      await expect(
        makeService().activate({ caseId, source: 'FORMAL_NOTIFICATION' }),
      ).rejects.toThrow();
    });
  });

  describe('R7.3 — deactivation', () => {
    it('resolves the open BREATHING_SPACE flag and emits BREATHING_SPACE_DEACTIVATED', async () => {
      const caseId = await createCase({});
      await makeService().activate({ caseId, source: 'FORMAL_NOTIFICATION' });

      const r = await makeService().deactivate({ caseId, note: 'creditor agreement reached' });
      expect(r.changed).toBe(true);

      const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(c.breathingSpaceActive).toBe(false);

      const flag = await prisma.escalationFlag.findFirstOrThrow({
        where: { caseId, kind: 'BREATHING_SPACE' },
      });
      expect(flag.resolvedAt).not.toBeNull();
      expect(flag.resolvedReason).toBe('creditor agreement reached');

      const events = await prisma.caseEvent.findMany({
        where: { caseId, kind: 'BREATHING_SPACE_DEACTIVATED' },
      });
      expect(events).toHaveLength(1);
    });

    it('does NOT retroactively fire past skipped entries', async () => {
      const caseId = await createCase({});
      const entryId = await createPendingChaseEntry(caseId);
      await makeService().activate({ caseId, source: 'FORMAL_NOTIFICATION' });
      const skippedAtActivate = await prisma.chaseScheduleEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(skippedAtActivate.skippedReason).toBe('BREATHING_SPACE_ACTIVE');

      await makeService().deactivate({ caseId });

      const stillSkipped = await prisma.chaseScheduleEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(stillSkipped.skippedReason).toBe('BREATHING_SPACE_ACTIVE');
      expect(stillSkipped.firedAt!.toISOString()).toBe(skippedAtActivate.firedAt!.toISOString());
    });

    it('R6 — re-evaluates S8 on deactivation, re-raising if balance is still over threshold', async () => {
      const caseId = await createCase({}); // £4000 over £3600
      await makeService().activate({ caseId, source: 'FORMAL_NOTIFICATION' });
      // While active, S8 is suppressed.
      let c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(c.s8Eligible).toBe(false);

      await makeService().deactivate({ caseId });

      c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(c.s8Eligible).toBe(true);

      const openS8 = await prisma.escalationFlag.findMany({
        where: { caseId, kind: 'S8_ELIGIBLE', resolvedAt: null },
      });
      expect(openS8).toHaveLength(1);
    });

    it('is idempotent — deactivating when already inactive returns changed=false', async () => {
      const caseId = await createCase({});
      const r = await makeService().deactivate({ caseId });
      expect(r.changed).toBe(false);
    });
  });
});
