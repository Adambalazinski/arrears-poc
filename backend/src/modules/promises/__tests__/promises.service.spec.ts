import { PrismaClient, PromiseStatus } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clock } from '../../../common/clock/clock.service';
import { DEFAULT_ORG_CONFIG } from '../../organisations/defaults';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';
import { PromisesService } from '../promises.service';
import { PromiseExpiryJob } from '../jobs/promise-expiry.job';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 'promises-test-org';
const TENANCY_ID = 'tenancy-promises-test';
const TENANT_CONTACT_ID = 'contact-promises-tenant';
const USER_ID = 'test-handler-user';

const FIXED_NOW = new Date('2026-05-20T10:00:00Z');

async function clearAll(): Promise<void> {
  await prisma.promise.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.communication.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.chaseScheduleEntry.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.reviewQueueItem.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancyContact.deleteMany({ where: { tenancy: { organisationId: ORG_ID } } });
  await prisma.contact.deleteMany({ where: { organisationId: ORG_ID } });
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
      name: 'Promises test org',
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
      propertyId: 'prop-promises',
      status: 'ACTIVE',
      rentAmountPence: 120000n,
      lastSyncedAt: FIXED_NOW,
    },
  });
  await prisma.contact.upsert({
    where: { id: TENANT_CONTACT_ID },
    update: {},
    create: {
      id: TENANT_CONTACT_ID,
      organisationId: ORG_ID,
      firstName: 'Promise',
      lastName: 'Maker',
      primaryEmail: 'promise.maker@example.com',
      emailsJson: [],
      phonesJson: [],
      lastSyncedAt: FIXED_NOW,
    },
  });
  await prisma.tenancyContact.upsert({
    where: {
      tenancyId_contactId_role: {
        tenancyId: TENANCY_ID,
        contactId: TENANT_CONTACT_ID,
        role: 'TENANT',
      },
    },
    update: {},
    create: { tenancyId: TENANCY_ID, contactId: TENANT_CONTACT_ID, role: 'TENANT' },
  });
});

afterEach(async () => {
  await prisma.promise.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.communication.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.chaseScheduleEntry.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.reviewQueueItem.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancyContact.deleteMany({ where: { tenancy: { organisationId: ORG_ID } } });
  await prisma.contact.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
});

function fakeClock(now: Date = FIXED_NOW): Clock {
  const c = new Clock();
  vi.spyOn(c, 'now').mockReturnValue(now);
  return c;
}

function makeService(clock?: Clock): PromisesService {
  return new PromisesService(prisma as unknown as PrismaService, clock ?? fakeClock());
}

async function createCase(): Promise<string> {
  const created = await prisma.case.create({
    data: {
      organisationId: ORG_ID,
      tenancyId: TENANCY_ID,
      status: 'ACTIVE',
      openedAt: FIXED_NOW,
      lastKnownBalancePence: 400000n,
      lastKnownBalanceAt: FIXED_NOW,
    },
  });
  await prisma.charge.create({
    data: {
      caseId: created.id,
      organisationId: ORG_ID,
      lwcaInvoiceId: `${created.id}-c-0`,
      dueDate: new Date('2026-01-01T00:00:00Z'),
      invoiceDate: new Date('2025-12-15T00:00:00Z'),
      grossAmountPence: 400000n,
      lastKnownRemainAmountPence: 400000n,
      lastKnownStatus: 'UNPAID',
      lastSyncedAt: FIXED_NOW,
    },
  });
  return created.id;
}

async function createPendingChaseEntry(caseId: string, role: 'TENANT' | 'GUARANTOR' = 'TENANT') {
  const charge = await prisma.charge.findFirstOrThrow({ where: { caseId } });
  return prisma.chaseScheduleEntry.create({
    data: {
      caseId,
      chargeId: charge.id,
      stage: role === 'TENANT' ? 'AWAITING_WD3' : 'AWAITING_WD5',
      recipientRole: role,
      dueAt: FIXED_NOW,
    },
  });
}

async function createPendingDraft(
  caseId: string,
  role: 'TENANT' | 'GUARANTOR' = 'TENANT',
  consolidatedStage: 'AWAITING_WD3' | null = 'AWAITING_WD3',
) {
  return prisma.communication.create({
    data: {
      organisationId: ORG_ID,
      caseId,
      direction: 'OUTBOUND',
      channel: 'EMAIL',
      recipientRole: role,
      toAddress: role === 'TENANT' ? 't@example.com' : 'g@example.com',
      subject: 'Reminder',
      bodyMarkdown: 'Hello',
      status: 'AWAITING_APPROVAL',
      consolidatedStage,
    },
  });
}

describe('PromisesService.create — validation', () => {
  it('rejects a promise date in the past', async () => {
    const caseId = await createCase();
    const svc = makeService();
    await expect(
      svc.create({
        caseId,
        promiseDate: new Date('2026-05-10T00:00:00Z'), // before FIXED_NOW
        createdByUserId: USER_ID,
      }),
    ).rejects.toThrow(/past/i);
  });

  it('rejects a promise date more than 15 days out', async () => {
    const caseId = await createCase();
    const svc = makeService();
    await expect(
      svc.create({
        caseId,
        promiseDate: new Date('2026-06-10T00:00:00Z'), // ~21 days from FIXED_NOW
        createdByUserId: USER_ID,
      }),
    ).rejects.toThrow(/15 days/i);
  });

  it('rejects when an ACTIVE promise already exists on the case', async () => {
    const caseId = await createCase();
    const svc = makeService();
    await svc.create({
      caseId,
      promiseDate: new Date('2026-05-25T00:00:00Z'),
      createdByUserId: USER_ID,
    });
    await expect(
      svc.create({
        caseId,
        promiseDate: new Date('2026-05-30T00:00:00Z'),
        createdByUserId: USER_ID,
      }),
    ).rejects.toThrow(/already has an active promise/i);
  });

  it('rejects a third promise within the 30-day cycle', async () => {
    const caseId = await createCase();
    const svc = makeService();
    await svc.create({
      caseId,
      promiseDate: new Date('2026-05-22T00:00:00Z'),
      createdByUserId: USER_ID,
    });
    const first = await prisma.promise.findFirstOrThrow({ where: { caseId } });
    await svc.cancel({ promiseId: first.id, resolvedByUserId: USER_ID });
    await svc.create({
      caseId,
      promiseDate: new Date('2026-05-24T00:00:00Z'),
      createdByUserId: USER_ID,
    });
    const second = await prisma.promise.findFirstOrThrow({
      where: { caseId, status: PromiseStatus.ACTIVE },
    });
    await svc.cancel({ promiseId: second.id, resolvedByUserId: USER_ID });
    await expect(
      svc.create({
        caseId,
        promiseDate: new Date('2026-05-26T00:00:00Z'),
        createdByUserId: USER_ID,
      }),
    ).rejects.toThrow(/last 30 days/i);
  });

  it('rejects when the case is not ACTIVE', async () => {
    const caseId = await createCase();
    await prisma.case.update({
      where: { id: caseId },
      data: { status: 'CLOSED', closedAt: FIXED_NOW },
    });
    const svc = makeService();
    await expect(
      svc.create({
        caseId,
        promiseDate: new Date('2026-05-25T00:00:00Z'),
        createdByUserId: USER_ID,
      }),
    ).rejects.toThrow(/not ACTIVE/);
  });
});

describe('PromisesService.create — cascade', () => {
  it('pauses both tracks: pending chase entries skipped with PROMISE_ACTIVE', async () => {
    const caseId = await createCase();
    const tEntry = await createPendingChaseEntry(caseId, 'TENANT');
    const gEntry = await createPendingChaseEntry(caseId, 'GUARANTOR');
    const r = await makeService().create({
      caseId,
      promiseDate: new Date('2026-05-25T00:00:00Z'),
      createdByUserId: USER_ID,
    });
    expect(r.chaseEntriesSkipped).toBe(2);
    const t = await prisma.chaseScheduleEntry.findUniqueOrThrow({ where: { id: tEntry.id } });
    expect(t.skippedReason).toBe('PROMISE_ACTIVE');
    expect(t.firedAt).not.toBeNull();
    const g = await prisma.chaseScheduleEntry.findUniqueOrThrow({ where: { id: gEntry.id } });
    expect(g.skippedReason).toBe('PROMISE_ACTIVE');
  });

  it('auto-rejects pending OUTBOUND drafts on both tracks', async () => {
    const caseId = await createCase();
    const td = await createPendingDraft(caseId, 'TENANT');
    const gd = await createPendingDraft(caseId, 'GUARANTOR');
    const r = await makeService().create({
      caseId,
      promiseDate: new Date('2026-05-25T00:00:00Z'),
      createdByUserId: USER_ID,
    });
    expect(r.draftsAutoRejected).toBe(2);
    const tdAfter = await prisma.communication.findUniqueOrThrow({ where: { id: td.id } });
    expect(tdAfter.status).toBe('AUTO_REJECTED');
    expect(tdAfter.rejectionReason).toBe('promise active');
    const gdAfter = await prisma.communication.findUniqueOrThrow({ where: { id: gd.id } });
    expect(gdAfter.status).toBe('AUTO_REJECTED');
  });

  it('does NOT auto-reject AI reply drafts (consolidatedStage=null)', async () => {
    // The very draft that triggered the AI-detected promise affordance
    // is an acknowledgement reply; it should survive the cascade so the
    // handler can still approve it.
    const caseId = await createCase();
    const chaseDraft = await createPendingDraft(caseId, 'TENANT', 'AWAITING_WD3');
    const aiReply = await createPendingDraft(caseId, 'TENANT', null);
    const r = await makeService().create({
      caseId,
      promiseDate: new Date('2026-05-25T00:00:00Z'),
      createdByUserId: USER_ID,
    });
    expect(r.draftsAutoRejected).toBe(1);

    const chaseAfter = await prisma.communication.findUniqueOrThrow({ where: { id: chaseDraft.id } });
    expect(chaseAfter.status).toBe('AUTO_REJECTED');

    const replyAfter = await prisma.communication.findUniqueOrThrow({ where: { id: aiReply.id } });
    expect(replyAfter.status).toBe('AWAITING_APPROVAL');
  });

  it('emits PROMISE_CREATED event with the cascade counts', async () => {
    const caseId = await createCase();
    await createPendingChaseEntry(caseId, 'TENANT');
    await createPendingDraft(caseId, 'TENANT');
    await makeService().create({
      caseId,
      promiseDate: new Date('2026-05-25T00:00:00Z'),
      createdByUserId: USER_ID,
      note: 'will pay on Friday',
    });
    const event = await prisma.caseEvent.findFirstOrThrow({
      where: { caseId, kind: 'PROMISE_CREATED' },
    });
    const payload = event.payloadJson as Record<string, unknown>;
    expect(payload.chaseEntriesSkipped).toBe(1);
    expect(payload.draftsAutoRejected).toBe(1);
    expect(payload.note).toBe('will pay on Friday');
  });
});

describe('PromisesService.markFulfilled / cancel', () => {
  it('markFulfilled transitions ACTIVE → FULFILLED and emits PROMISE_FULFILLED', async () => {
    const caseId = await createCase();
    const svc = makeService();
    const { promise } = await svc.create({
      caseId,
      promiseDate: new Date('2026-05-25T00:00:00Z'),
      createdByUserId: USER_ID,
    });
    const updated = await svc.markFulfilled({
      promiseId: promise.id,
      resolvedByUserId: USER_ID,
      note: 'paid via bank transfer',
    });
    expect(updated.status).toBe(PromiseStatus.FULFILLED);
    const events = await prisma.caseEvent.findMany({
      where: { caseId, kind: 'PROMISE_FULFILLED' },
    });
    expect(events).toHaveLength(1);
  });

  it('cancel transitions ACTIVE → CANCELLED', async () => {
    const caseId = await createCase();
    const svc = makeService();
    const { promise } = await svc.create({
      caseId,
      promiseDate: new Date('2026-05-25T00:00:00Z'),
      createdByUserId: USER_ID,
    });
    const updated = await svc.cancel({
      promiseId: promise.id,
      resolvedByUserId: USER_ID,
      note: 'tenant retracted',
    });
    expect(updated.status).toBe(PromiseStatus.CANCELLED);
  });

  it('cannot resolve an already-resolved promise', async () => {
    const caseId = await createCase();
    const svc = makeService();
    const { promise } = await svc.create({
      caseId,
      promiseDate: new Date('2026-05-25T00:00:00Z'),
      createdByUserId: USER_ID,
    });
    await svc.cancel({ promiseId: promise.id, resolvedByUserId: USER_ID });
    await expect(
      svc.markFulfilled({ promiseId: promise.id, resolvedByUserId: USER_ID }),
    ).rejects.toThrow();
  });

  it('does not retroactively un-skip past chase entries on resolution', async () => {
    const caseId = await createCase();
    const entry = await createPendingChaseEntry(caseId, 'TENANT');
    const svc = makeService();
    const { promise } = await svc.create({
      caseId,
      promiseDate: new Date('2026-05-25T00:00:00Z'),
      createdByUserId: USER_ID,
    });
    await svc.markFulfilled({ promiseId: promise.id, resolvedByUserId: USER_ID });
    const e = await prisma.chaseScheduleEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(e.skippedReason).toBe('PROMISE_ACTIVE');
  });
});

describe('PromisesService.markBroken + PromiseExpiryJob', () => {
  it('markBroken transitions ACTIVE → BROKEN, emits event, drafts a broken-promise email', async () => {
    const caseId = await createCase();
    const create = makeService(fakeClock(new Date('2026-05-19T10:00:00Z')));
    const { promise } = await create.create({
      caseId,
      promiseDate: new Date('2026-05-19T23:59:00Z'),
      createdByUserId: USER_ID,
    });
    const breakClock = fakeClock(new Date('2026-05-21T00:00:00Z'));
    const breakSvc = new PromisesService(prisma as unknown as PrismaService, breakClock);
    const updated = await breakSvc.markBroken(promise.id);
    expect(updated.status).toBe(PromiseStatus.BROKEN);

    const draft = await prisma.communication.findFirstOrThrow({
      where: { caseId, status: 'AWAITING_APPROVAL', recipientRole: 'TENANT' },
    });
    expect(draft.subject).toMatch(/promise/i);

    const rqi = await prisma.reviewQueueItem.findFirstOrThrow({
      where: { caseId, communicationId: draft.id },
    });
    expect(rqi.priority).toBe('HIGH');

    const events = await prisma.caseEvent.findMany({
      where: { caseId, kind: 'PROMISE_BROKEN' },
    });
    expect(events).toHaveLength(1);
  });

  it('expiry job marks every past ACTIVE promise BROKEN; idempotent on re-run', async () => {
    const caseId = await createCase();
    const create = makeService(fakeClock(new Date('2026-05-19T10:00:00Z')));
    await create.create({
      caseId,
      promiseDate: new Date('2026-05-19T23:59:00Z'),
      createdByUserId: USER_ID,
    });
    const job = new PromiseExpiryJob(
      prisma as unknown as PrismaService,
      fakeClock(new Date('2026-05-22T00:00:00Z')),
      new PromisesService(
        prisma as unknown as PrismaService,
        fakeClock(new Date('2026-05-22T00:00:00Z')),
      ),
    );
    const first = await job.runOnce();
    expect(first.checked).toBe(1);
    expect(first.broken).toBe(1);

    const second = await job.runOnce();
    expect(second.checked).toBe(0);
    expect(second.broken).toBe(0);
  });
});
