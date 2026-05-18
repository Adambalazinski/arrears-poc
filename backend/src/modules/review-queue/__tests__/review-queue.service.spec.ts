import { PrismaClient, type Charge } from '@prisma/client';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  OutboundSendError,
  type OutboundMailer,
} from '../../../integrations/outlook/outlook.types';
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
  await prisma.classificationResult.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.escalationFlag.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
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

function makeMailer(): OutboundMailer & { sendMail: ReturnType<typeof vi.fn> } {
  return {
    sendMail: vi.fn(async (input) => ({
      messageId: `mock:${input.toAddress}:${Date.now()}`,
      acceptedAt: new Date(),
    })),
  };
}

function makeService(
  mailer: OutboundMailer = makeMailer(),
): { svc: ReviewQueueService; mailer: OutboundMailer } {
  const svc = new ReviewQueueService(
    prisma as unknown as PrismaService,
    noopPoll,
    mailer,
  );
  return { svc, mailer };
}

describe('ReviewQueueService', () => {
  it('list returns pending items, newest priority first', async () => {
    await seedDraft();
    const { svc } = makeService();
    const items = await svc.list(ORG_ID);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('OUTBOUND_DRAFT_APPROVAL');
    expect(items[0]!.communication?.subject).toBe('Outstanding rent');
  });

  it('approve sends via mailer and flips Communication to SENT', async () => {
    const seeded = await seedDraft();
    const mailer = makeMailer();
    const { svc } = makeService(mailer);
    const r = await svc.approve(seeded.reviewItemId, ACTOR_ID);
    expect(r.ok).toBe(true);
    expect(r).toHaveProperty('messageId');
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(mailer.sendMail).toHaveBeenCalledWith({
      toAddress: 'tenant@example.com',
      subject: 'Outstanding rent',
      bodyMarkdown: expect.stringContaining('Owe 200000 pence'),
    });

    const comm = await prisma.communication.findUniqueOrThrow({
      where: { id: seeded.communicationId },
    });
    expect(comm.status).toBe('SENT');
    expect(comm.approvedByUserId).toBe(ACTOR_ID);
    expect(comm.approvedAt).not.toBeNull();
    expect(comm.sentAt).not.toBeNull();
    expect(comm.outlookSentMessageId).toMatch(/^mock:tenant@example\.com:/);

    const item = await prisma.reviewQueueItem.findUniqueOrThrow({
      where: { id: seeded.reviewItemId },
    });
    expect(item.resolvedAt).not.toBeNull();
    expect(item.resolution).toBe('APPROVED_AND_SENT');

    const kinds = (
      await prisma.caseEvent.findMany({ where: { caseId: seeded.caseId } })
    ).map((e) => e.kind);
    expect(kinds).toContain('COMMUNICATION_APPROVED');
    expect(kinds).toContain('COMMUNICATION_SENT');
  });

  it('edit-then-approve persists the edited body and resolves as EDITED_AND_SENT', async () => {
    const seeded = await seedDraft();
    const mailer = makeMailer();
    const { svc } = makeService(mailer);
    await svc.approve(seeded.reviewItemId, ACTOR_ID, 'Edited body for the tenant');
    const comm = await prisma.communication.findUniqueOrThrow({
      where: { id: seeded.communicationId },
    });
    expect(comm.bodyMarkdown).toBe('Edited body for the tenant');
    expect(comm.status).toBe('SENT');
    // The mailer received the edited body.
    expect(mailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ bodyMarkdown: 'Edited body for the tenant' }),
    );
    const item = await prisma.reviewQueueItem.findUniqueOrThrow({
      where: { id: seeded.reviewItemId },
    });
    expect(item.resolution).toBe('EDITED_AND_SENT');
  });

  it('mailer failure -> Communication SEND_FAILED with sendErrorJson; queue item stays pending', async () => {
    const seeded = await seedDraft();
    const failing: OutboundMailer = {
      sendMail: vi.fn(async () => {
        throw new OutboundSendError('SMTP refused');
      }),
    };
    const { svc } = makeService(failing);
    await expect(svc.approve(seeded.reviewItemId, ACTOR_ID)).rejects.toBeInstanceOf(
      OutboundSendError,
    );
    const comm = await prisma.communication.findUniqueOrThrow({
      where: { id: seeded.communicationId },
    });
    expect(comm.status).toBe('SEND_FAILED');
    expect(comm.sendErrorJson).toMatchObject({ message: 'SMTP refused' });
    expect(comm.sentAt).toBeNull();
    expect(comm.outlookSentMessageId).toBeNull();
    // The reviewer can retry — queue item still unresolved.
    const item = await prisma.reviewQueueItem.findUniqueOrThrow({
      where: { id: seeded.reviewItemId },
    });
    expect(item.resolvedAt).toBeNull();
  });

  it('R9.2: rejects approve with BalanceChangedError when a charge has been paid', async () => {
    const seeded = await seedDraft();
    await prisma.charge.update({
      where: { id: seeded.charges[0]!.id },
      data: { lastKnownRemainAmountPence: 0n, lastKnownStatus: 'PAID' },
    });
    const mailer = makeMailer();
    const { svc } = makeService(mailer);
    await expect(svc.approve(seeded.reviewItemId, ACTOR_ID)).rejects.toBeInstanceOf(
      BalanceChangedError,
    );
    expect(mailer.sendMail).not.toHaveBeenCalled();
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
    const comm = await prisma.communication.findUniqueOrThrow({
      where: { id: seeded.communicationId },
    });
    expect(comm.status).toBe('AWAITING_APPROVAL');
  });

  it('R9.2: small remain delta within the 1p tolerance is allowed', async () => {
    const seeded = await seedDraft();
    await prisma.charge.update({
      where: { id: seeded.charges[0]!.id },
      data: { lastKnownRemainAmountPence: 119_999n },
    });
    const { svc } = makeService();
    const r = await svc.approve(seeded.reviewItemId, ACTOR_ID);
    expect(r.ok).toBe(true);
  });

  it('R9.2: delta > 1p triggers BalanceChangedError', async () => {
    const seeded = await seedDraft();
    await prisma.charge.update({
      where: { id: seeded.charges[0]!.id },
      data: { lastKnownRemainAmountPence: 119_998n },
    });
    const { svc } = makeService();
    await expect(svc.approve(seeded.reviewItemId, ACTOR_ID)).rejects.toBeInstanceOf(
      BalanceChangedError,
    );
  });

  it('reject: marks Communication REJECTED + ReviewQueueItem resolved with reason', async () => {
    const seeded = await seedDraft();
    const { svc } = makeService();
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
    const { svc } = makeService();
    await svc.approve(seeded.reviewItemId, ACTOR_ID);
    await expect(svc.approve(seeded.reviewItemId, ACTOR_ID)).rejects.toThrow(/already resolved/);
  });
});

async function seedInboundLowConfidence(opts: {
  withClassification?: boolean;
  reason?: string;
} = {}): Promise<{ caseId: string; communicationId: string; reviewItemId: string }> {
  const caseRow = await prisma.case.create({
    data: {
      organisationId: ORG_ID,
      tenancyId: TENANCY_ID,
      status: 'ACTIVE',
      openedAt: new Date('2026-05-10T00:00:00Z'),
      lastKnownBalancePence: 240_000n,
      lastKnownBalanceAt: new Date(),
    },
  });
  const comm = await prisma.communication.create({
    data: {
      caseId: caseRow.id,
      organisationId: ORG_ID,
      direction: 'INBOUND',
      channel: 'EMAIL',
      status: 'PROCESSED',
      fromAddress: 'jane@example.com',
      subject: 'Question about my charges',
      rawBodyText: 'Could you give me more detail on the additional fees?',
      receivedAt: new Date('2026-05-18T08:30:00Z'),
      outlookMessageId: `msg-${caseRow.id}`,
    },
  });
  let classificationResultId: string | null = null;
  if (opts.withClassification) {
    const cr = await prisma.classificationResult.create({
      data: {
        caseId: caseRow.id,
        communicationId: comm.id,
        preFilterMatched: false,
        modelUsed: 'claude-haiku-4-5',
        sentiment: 'NEUTRAL',
        intent: 'COMPLAINT',
        confidence: 0.91,
        rationale: 'tenant questioning fee structure',
        promptTokens: 500,
        completionTokens: 40,
        estimatedCostPence: 1,
      },
    });
    classificationResultId = cr.id;
  }
  const item = await prisma.reviewQueueItem.create({
    data: {
      organisationId: ORG_ID,
      caseId: caseRow.id,
      kind: 'INBOUND_LOW_CONFIDENCE',
      communicationId: comm.id,
      priority: 'HIGH',
      classificationResultId,
    },
  });
  return { caseId: caseRow.id, communicationId: comm.id, reviewItemId: item.id };
}

async function seedHardTriggerEscalation(): Promise<{
  caseId: string;
  communicationId: string;
  reviewItemId: string;
}> {
  const caseRow = await prisma.case.create({
    data: {
      organisationId: ORG_ID,
      tenancyId: TENANCY_ID,
      status: 'ACTIVE',
      openedAt: new Date('2026-05-10T00:00:00Z'),
      lastKnownBalancePence: 300_000n,
      lastKnownBalanceAt: new Date(),
    },
  });
  const comm = await prisma.communication.create({
    data: {
      caseId: caseRow.id,
      organisationId: ORG_ID,
      direction: 'INBOUND',
      channel: 'EMAIL',
      status: 'PROCESSED',
      fromAddress: 'jane@example.com',
      subject: 'Bereavement',
      rawBodyText: 'My partner passed away last week — please give me time.',
      receivedAt: new Date('2026-05-18T09:00:00Z'),
      outlookMessageId: `msg-ht-${caseRow.id}`,
    },
  });
  const cr = await prisma.classificationResult.create({
    data: {
      caseId: caseRow.id,
      communicationId: comm.id,
      preFilterMatched: true,
      preFilterTriggerKind: 'DOMESTIC_CIRCUMSTANCES',
      preFilterMatchedKeyword: 'passed away',
    },
  });
  const item = await prisma.reviewQueueItem.create({
    data: {
      organisationId: ORG_ID,
      caseId: caseRow.id,
      kind: 'HARD_TRIGGER_ESCALATION',
      communicationId: comm.id,
      priority: 'URGENT',
      classificationResultId: cr.id,
    },
  });
  return { caseId: caseRow.id, communicationId: comm.id, reviewItemId: item.id };
}

describe('ReviewQueueService.list — hasAiRationale flag', () => {
  it('flags items with a linked classification result', async () => {
    const inboundLinked = await seedInboundLowConfidence({ withClassification: true });
    // Add a second inbound item on a different tenancy without a
    // classification link so we can compare both flag values in one
    // assertion.
    await prisma.tenancy.create({
      data: {
        id: 'tn-unlinked',
        organisationId: ORG_ID,
        propertyId: 'p',
        status: 'ACTIVE',
        lastSyncedAt: new Date(),
      },
    });
    const otherCase = await prisma.case.create({
      data: {
        organisationId: ORG_ID,
        tenancyId: 'tn-unlinked',
        status: 'ACTIVE',
        openedAt: new Date(),
        lastKnownBalancePence: 0n,
        lastKnownBalanceAt: new Date(),
      },
    });
    const otherComm = await prisma.communication.create({
      data: {
        caseId: otherCase.id,
        organisationId: ORG_ID,
        direction: 'INBOUND',
        channel: 'EMAIL',
        status: 'PROCESSED',
        fromAddress: 'x@example.com',
        outlookMessageId: 'msg-unlinked',
      },
    });
    const unlinked = await prisma.reviewQueueItem.create({
      data: {
        organisationId: ORG_ID,
        caseId: otherCase.id,
        kind: 'INBOUND_LOW_CONFIDENCE',
        communicationId: otherComm.id,
        priority: 'HIGH',
        classificationResultId: null,
      },
    });

    const { svc } = makeService();
    const items = await svc.list(ORG_ID);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(inboundLinked.reviewItemId)?.hasAiRationale).toBe(true);
    expect(byId.get(unlinked.id)?.hasAiRationale).toBe(false);
  });
});

describe('ReviewQueueService.get — classification + inbound body', () => {
  it('returns the classification panel for INBOUND_LOW_CONFIDENCE with a linked result', async () => {
    const seeded = await seedInboundLowConfidence({ withClassification: true });
    const { svc } = makeService();
    const detail = await svc.get(seeded.reviewItemId);
    expect(detail.classification?.modelUsed).toBe('claude-haiku-4-5');
    expect(detail.classification?.sentiment).toBe('NEUTRAL');
    expect(detail.classification?.intent).toBe('COMPLAINT');
    expect(detail.classification?.confidence).toBe('0.91');
    expect(detail.classification?.rationale).toBe('tenant questioning fee structure');
    expect(detail.inbound?.rawBodyText).toBe(
      'Could you give me more detail on the additional fees?',
    );
  });

  it('returns null classification and still shows inbound body when classify failed', async () => {
    const seeded = await seedInboundLowConfidence({ withClassification: false });
    const { svc } = makeService();
    const detail = await svc.get(seeded.reviewItemId);
    expect(detail.classification).toBeNull();
    expect(detail.inbound?.rawBodyText).toBe(
      'Could you give me more detail on the additional fees?',
    );
  });

  it('returns pre-filter trigger details for HARD_TRIGGER_ESCALATION', async () => {
    const seeded = await seedHardTriggerEscalation();
    const { svc } = makeService();
    const detail = await svc.get(seeded.reviewItemId);
    expect(detail.classification?.preFilterMatched).toBe(true);
    expect(detail.classification?.preFilterTriggerKind).toBe('DOMESTIC_CIRCUMSTANCES');
    expect(detail.classification?.preFilterMatchedKeyword).toBe('passed away');
    expect(detail.inbound?.rawBodyText).toContain('passed away');
  });
});

describe('ReviewQueueService.dismiss', () => {
  it('resolves an INBOUND_LOW_CONFIDENCE item with HANDLER_ACTIONED and emits HANDLER_ASSIGNED', async () => {
    const seeded = await seedInboundLowConfidence({ withClassification: true });
    const { svc } = makeService();
    const res = await svc.dismiss(seeded.reviewItemId, ACTOR_ID, 'called tenant directly');
    expect(res.ok).toBe(true);

    const item = await prisma.reviewQueueItem.findUniqueOrThrow({
      where: { id: seeded.reviewItemId },
    });
    expect(item.resolution).toBe('HANDLER_ACTIONED');
    expect(item.resolvedByUserId).toBe(ACTOR_ID);

    // The INBOUND communication's status is untouched.
    const comm = await prisma.communication.findUniqueOrThrow({
      where: { id: seeded.communicationId },
    });
    expect(comm.status).toBe('PROCESSED');

    const event = await prisma.caseEvent.findFirstOrThrow({
      where: { caseId: seeded.caseId, kind: 'HANDLER_ASSIGNED' },
    });
    const payload = event.payloadJson as Record<string, unknown>;
    expect(payload.action).toBe('dismissed');
    expect(payload.note).toBe('called tenant directly');
    expect(payload.kind).toBe('INBOUND_LOW_CONFIDENCE');
  });

  it('also accepts HARD_TRIGGER_ESCALATION items', async () => {
    const seeded = await seedHardTriggerEscalation();
    const { svc } = makeService();
    await svc.dismiss(seeded.reviewItemId, ACTOR_ID);
    const item = await prisma.reviewQueueItem.findUniqueOrThrow({
      where: { id: seeded.reviewItemId },
    });
    expect(item.resolution).toBe('HANDLER_ACTIONED');
  });

  it('refuses to dismiss an OUTBOUND_DRAFT_APPROVAL item', async () => {
    const seeded = await seedDraft();
    const { svc } = makeService();
    await expect(svc.dismiss(seeded.reviewItemId, ACTOR_ID)).rejects.toThrow(
      /dismiss only applies to inbound/,
    );
  });

  it('refuses to dismiss an already-resolved item', async () => {
    const seeded = await seedInboundLowConfidence();
    const { svc } = makeService();
    await svc.dismiss(seeded.reviewItemId, ACTOR_ID);
    await expect(svc.dismiss(seeded.reviewItemId, ACTOR_ID)).rejects.toThrow(
      /already resolved/,
    );
  });

  it('refuses reject() on an INBOUND_LOW_CONFIDENCE item (use dismiss instead)', async () => {
    const seeded = await seedInboundLowConfidence();
    const { svc } = makeService();
    await expect(svc.reject(seeded.reviewItemId, ACTOR_ID, 'no')).rejects.toThrow(
      /use dismiss for inbound items/,
    );
  });
});
