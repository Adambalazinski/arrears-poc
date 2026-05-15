import { PrismaClient, type Charge } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';
import type { LwcaInvoicePollJob } from '../../cases/jobs/lwca-invoice-poll.job';
import { buildDraftSnapshot } from '../../chase/digest/digest.service';
import { DEFAULT_ORG_CONFIG } from '../../organisations/defaults';
import { BalanceChangedError, ReviewQueueService } from '../review-queue.service';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 'review-queue-test-org';
const TENANCY_ID = 'review-queue-tenancy';
const ACTOR_ID = '11111111-1111-1111-1111-111111111111';

// Stub the LWCA poll dependency so the R9 re-sync is a no-op; tests
// mutate Charge.lastKnownRemainAmountPence directly to simulate payments.
const noopPoll: LwcaInvoicePollJob = {
  runForOrg: async () => ({
    organisationId: ORG_ID,
    syncJobRunId: 'noop',
    processed: 0,
    created: 0,
    updated: 0,
    casesOpened: 0,
    casesClosed: 0,
    status: 'COMPLETED' as const,
  }),
} as unknown as LwcaInvoicePollJob;

async function wipe(): Promise<void> {
  await prisma.reviewQueueItem.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.communication.deleteMany({ where: { organisationId: ORG_ID } });
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
  await prisma.organisation.create({ data: { id: ORG_ID, name: 'Review queue test' } });
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

interface SeededDraft {
  caseId: string;
  communicationId: string;
  reviewItemId: string;
  charges: Charge[];
}

async function seedDraft(opts: { chargeRemains?: bigint[] } = {}): Promise<SeededDraft> {
  const remains = opts.chargeRemains ?? [120_000n, 80_000n];
  const caseRow = await prisma.case.create({
    data: {
      organisationId: ORG_ID,
      tenancyId: TENANCY_ID,
      status: 'ACTIVE',
      openedAt: new Date('2026-05-10T00:00:00Z'),
      lastKnownBalancePence: remains.reduce((a, b) => a + b, 0n),
      lastKnownBalanceAt: new Date(),
    },
  });
  const charges = await Promise.all(
    remains.map((r, i) =>
      prisma.charge.create({
        data: {
          caseId: caseRow.id,
          organisationId: ORG_ID,
          lwcaInvoiceId: `inv-${caseRow.id}-${i}`,
          dueDate: new Date('2026-05-01T00:00:00Z'),
          invoiceDate: new Date('2026-04-15T00:00:00Z'),
          grossAmountPence: 120_000n,
          lastKnownRemainAmountPence: r,
          lastKnownStatus: 'UNPAID',
          lastSyncedAt: new Date(),
        },
      }),
    ),
  );
  const snapshot = buildDraftSnapshot(charges);
  const comm = await prisma.communication.create({
    data: {
      caseId: caseRow.id,
      organisationId: ORG_ID,
      direction: 'OUTBOUND',
      channel: 'EMAIL',
      status: 'AWAITING_APPROVAL',
      consolidatedStage: 'AWAITING_WD8',
      recipientRole: 'TENANT',
      toAddress: 'tenant@example.com',
      subject: 'Outstanding rent',
      bodyMarkdown: `Owe ${snapshot.balancePence} pence`,
      draftedByAi: false,
      draftSnapshotJson: snapshot as unknown as object,
      charges: { connect: charges.map((ch) => ({ id: ch.id })) },
    },
  });
  const item = await prisma.reviewQueueItem.create({
    data: {
      organisationId: ORG_ID,
      caseId: caseRow.id,
      kind: 'OUTBOUND_DRAFT_APPROVAL',
      communicationId: comm.id,
      priority: 'NORMAL',
    },
  });
  return { caseId: caseRow.id, communicationId: comm.id, reviewItemId: item.id, charges };
}

function makeService(): ReviewQueueService {
  return new ReviewQueueService(prisma as unknown as PrismaService, noopPoll);
}

describe('ReviewQueueService', () => {
  it('list returns pending items, newest priority first', async () => {
    await seedDraft();
    const svc = makeService();
    const items = await svc.list(ORG_ID);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('OUTBOUND_DRAFT_APPROVAL');
    expect(items[0]!.communication?.subject).toBe('Outstanding rent');
  });

  it('approve: marks Communication APPROVED + ReviewQueueItem resolved when balance is unchanged', async () => {
    const seeded = await seedDraft();
    const r = await makeService().approve(seeded.reviewItemId, ACTOR_ID);
    expect(r.ok).toBe(true);
    const comm = await prisma.communication.findUniqueOrThrow({
      where: { id: seeded.communicationId },
    });
    expect(comm.status).toBe('APPROVED');
    expect(comm.approvedByUserId).toBe(ACTOR_ID);
    expect(comm.approvedAt).not.toBeNull();
    const item = await prisma.reviewQueueItem.findUniqueOrThrow({
      where: { id: seeded.reviewItemId },
    });
    expect(item.resolvedAt).not.toBeNull();
    expect(item.resolution).toBe('APPROVED_AND_SENT');
    const event = await prisma.caseEvent.findFirstOrThrow({
      where: { caseId: seeded.caseId, kind: 'COMMUNICATION_APPROVED' },
    });
    expect(event.actorUserId).toBe(ACTOR_ID);
  });

  it('approve: edited body is persisted when editedBodyMarkdown is provided', async () => {
    const seeded = await seedDraft();
    await makeService().approve(seeded.reviewItemId, ACTOR_ID, 'Edited body');
    const comm = await prisma.communication.findUniqueOrThrow({
      where: { id: seeded.communicationId },
    });
    expect(comm.bodyMarkdown).toBe('Edited body');
    expect(comm.status).toBe('APPROVED');
  });

  it('R9.2: rejects approve with BalanceChangedError when a charge has been paid', async () => {
    const seeded = await seedDraft();
    // Simulate a payment landing between draft and approve: one charge
    // now reads PAID + remain=0.
    await prisma.charge.update({
      where: { id: seeded.charges[0]!.id },
      data: { lastKnownRemainAmountPence: 0n, lastKnownStatus: 'PAID' },
    });
    const svc = makeService();
    await expect(svc.approve(seeded.reviewItemId, ACTOR_ID)).rejects.toBeInstanceOf(
      BalanceChangedError,
    );
    try {
      await svc.approve(seeded.reviewItemId, ACTOR_ID);
    } catch (err) {
      const e = err as BalanceChangedError;
      const changed = e.detail.perCharge.filter((c) => c.changed);
      expect(changed).toHaveLength(1);
      expect(changed[0]!.chargeId).toBe(seeded.charges[0]!.id);
      expect(changed[0]!.currentStatus).toBe('PAID');
      expect(e.detail.currentBalancePence).toBe('80000');
      expect(e.detail.draftBalancePence).toBe('200000');
    }
    // The Communication is still AWAITING_APPROVAL — not auto-rejected.
    const comm = await prisma.communication.findUniqueOrThrow({
      where: { id: seeded.communicationId },
    });
    expect(comm.status).toBe('AWAITING_APPROVAL');
  });

  it('R9.2: small remain delta within the 1p tolerance is allowed', async () => {
    const seeded = await seedDraft();
    // 1p change is exactly the tolerance — should not trigger.
    await prisma.charge.update({
      where: { id: seeded.charges[0]!.id },
      data: { lastKnownRemainAmountPence: 119_999n },
    });
    const r = await makeService().approve(seeded.reviewItemId, ACTOR_ID);
    expect(r.ok).toBe(true);
  });

  it('R9.2: delta > 1p triggers BalanceChangedError', async () => {
    const seeded = await seedDraft();
    await prisma.charge.update({
      where: { id: seeded.charges[0]!.id },
      data: { lastKnownRemainAmountPence: 119_998n },
    });
    await expect(makeService().approve(seeded.reviewItemId, ACTOR_ID)).rejects.toBeInstanceOf(
      BalanceChangedError,
    );
  });

  it('reject: marks Communication REJECTED + ReviewQueueItem resolved with reason', async () => {
    const seeded = await seedDraft();
    const svc = makeService();
    await svc.reject(seeded.reviewItemId, ACTOR_ID, 'tenant called and paid');
    const comm = await prisma.communication.findUniqueOrThrow({
      where: { id: seeded.communicationId },
    });
    expect(comm.status).toBe('REJECTED');
    expect(comm.rejectionReason).toBe('tenant called and paid');
    const item = await prisma.reviewQueueItem.findUniqueOrThrow({
      where: { id: seeded.reviewItemId },
    });
    expect(item.resolution).toBe('REJECTED');
    const event = await prisma.caseEvent.findFirstOrThrow({
      where: { caseId: seeded.caseId, kind: 'COMMUNICATION_REJECTED' },
    });
    expect((event.payloadJson as { reason: string }).reason).toBe('tenant called and paid');
  });

  it('refuses to approve an already-resolved item', async () => {
    const seeded = await seedDraft();
    const svc = makeService();
    await svc.approve(seeded.reviewItemId, ACTOR_ID);
    await expect(svc.approve(seeded.reviewItemId, ACTOR_ID)).rejects.toThrow(/already resolved/);
  });
});
