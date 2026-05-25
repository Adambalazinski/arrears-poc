import { PrismaClient, type Case, type CaseStatus, type ChargeStatus } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CasesService } from '../cases.service';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

// Real Postgres so we exercise the partial unique index on
// case(tenancyId) WHERE status='ACTIVE'. Tests clean up after themselves.
const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 'rules-test-org';

async function clearAll(): Promise<void> {
  // Order respects foreign keys.
  await prisma.reviewQueueItem.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.communication.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.classificationResult.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.escalationFlag.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.chaseScheduleEntry.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisationConfig.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisationCredential.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisation.deleteMany({ where: { id: ORG_ID } });
}

const TENANCY_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'].map(
  (suffix) => `tenancy-${suffix}`,
);

beforeAll(async () => {
  await prisma.$connect();
  await clearAll();
  await prisma.organisation.create({ data: { id: ORG_ID, name: 'Rules test org' } });
});

beforeEach(async () => {
  await Promise.all(TENANCY_IDS.map((id) => ensureTenancy(id)));
});

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

afterEach(async () => {
  // Wipe per-test rows but keep the organisation row so each test starts
  // from a clean slate.
  await prisma.reviewQueueItem.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.communication.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.chaseScheduleEntry.deleteMany({
    where: { case: { organisationId: ORG_ID } },
  });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG_ID } } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.case.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancyContact.deleteMany({ where: { tenancy: { organisationId: ORG_ID } } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
});

/** Case.tenancyId is a FK to Tenancy.id. Real flow: Phase 4.4 creates the
 * Tenancy row from Rentancy at case open. In these tests we seed a stub
 * Tenancy so the case service's FK is satisfied. */
async function ensureTenancy(tenancyId: string): Promise<void> {
  await prisma.tenancy.upsert({
    where: { id: tenancyId },
    update: {},
    create: {
      id: tenancyId,
      organisationId: ORG_ID,
      propertyId: `prop-${tenancyId}`,
      status: 'ACTIVE',
      lastSyncedAt: new Date(),
    },
  });
}

function makeService(): CasesService {
  return new CasesService(prisma as unknown as PrismaService);
}

async function attachCharge(
  caseId: string,
  lwcaId: string,
  remainPence: bigint,
  status: ChargeStatus = 'UNPAID',
): Promise<void> {
  await prisma.charge.create({
    data: {
      caseId,
      organisationId: ORG_ID,
      lwcaInvoiceId: lwcaId,
      dueDate: new Date('2026-04-01T00:00:00Z'),
      invoiceDate: new Date('2026-03-15T00:00:00Z'),
      grossAmountPence: remainPence,
      lastKnownRemainAmountPence: remainPence,
      lastKnownStatus: status,
      lastSyncedAt: new Date(),
    },
  });
}

describe('CasesService — R1 case opens', () => {
  it('opens a new case the first time openOrAttach is called for a tenancy', async () => {
    const svc = makeService();
    const r = await svc.openOrAttach(ORG_ID, 'tenancy-a');
    expect(r.opened).toBe(true);

    const row = (await prisma.case.findUnique({ where: { id: r.caseId } })) as Case;
    expect(row.status).toBe('ACTIVE' satisfies CaseStatus);
    expect(row.tenancyId).toBe('tenancy-a');

    const events = await prisma.caseEvent.findMany({ where: { caseId: r.caseId } });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('CASE_OPENED');
  });

  it('attaches to the existing active case when called again for the same tenancy', async () => {
    const svc = makeService();
    const a = await svc.openOrAttach(ORG_ID, 'tenancy-b');
    const b = await svc.openOrAttach(ORG_ID, 'tenancy-b');
    expect(b.opened).toBe(false);
    expect(b.caseId).toBe(a.caseId);
    const count = await prisma.case.count({
      where: { organisationId: ORG_ID, tenancyId: 'tenancy-b' },
    });
    expect(count).toBe(1);
  });

  it('opens distinct cases for distinct tenancies', async () => {
    const svc = makeService();
    const a = await svc.openOrAttach(ORG_ID, 'tenancy-c');
    const b = await svc.openOrAttach(ORG_ID, 'tenancy-d');
    expect(a.caseId).not.toBe(b.caseId);
  });

  it('R1.3: partial unique index blocks a second ACTIVE case per tenancy', async () => {
    // Bypass the service and try to insert two ACTIVE rows directly. The
    // partial unique index `one_active_case_per_tenancy` should reject the
    // second one with SQLSTATE 23505.
    await prisma.case.create({
      data: {
        organisationId: ORG_ID,
        tenancyId: 'tenancy-e',
        status: 'ACTIVE',
        openedAt: new Date(),
        lastKnownBalancePence: 0n,
        lastKnownBalanceAt: new Date(),
      },
    });
    await expect(
      prisma.case.create({
        data: {
          organisationId: ORG_ID,
          tenancyId: 'tenancy-e',
          status: 'ACTIVE',
          openedAt: new Date(),
          lastKnownBalancePence: 0n,
          lastKnownBalanceAt: new Date(),
        },
      }),
    ).rejects.toThrow(/Unique constraint failed on the fields/);

    // After the rejection the only ACTIVE row for tenancy-e is still the first one.
    const activeRows = await prisma.case.findMany({
      where: { organisationId: ORG_ID, tenancyId: 'tenancy-e', status: 'ACTIVE' },
    });
    expect(activeRows).toHaveLength(1);

    // A CLOSED case on the same tenancy is allowed (because the index has WHERE status='ACTIVE').
    const closedOk = await prisma.case.create({
      data: {
        organisationId: ORG_ID,
        tenancyId: 'tenancy-e',
        status: 'CLOSED',
        openedAt: new Date(),
        closedAt: new Date(),
        lastKnownBalancePence: 0n,
        lastKnownBalanceAt: new Date(),
      },
    });
    expect(closedOk.id).toBeDefined();
  });

  it('after a case closes, a fresh openOrAttach for the same tenancy opens a new case', async () => {
    const svc = makeService();
    const first = await svc.openOrAttach(ORG_ID, 'tenancy-f');
    await prisma.case.update({
      where: { id: first.caseId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    const second = await svc.openOrAttach(ORG_ID, 'tenancy-f');
    expect(second.opened).toBe(true);
    expect(second.caseId).not.toBe(first.caseId);
  });

  it('allows two ACTIVE cases for the same tenancyId across different orgs', async () => {
    // The partial unique index is per-(organisationId, tenancyId), not
    // global, so cross-org test setups stop tripping the unique violation
    // we kept hitting when swapping workspaces.
    const OTHER_ORG = 'second-rules-test-org';
    await prisma.organisation.upsert({
      where: { id: OTHER_ORG },
      create: { id: OTHER_ORG, name: 'Second rules org' },
      update: {},
    });
    // Both orgs need a Tenancy row to satisfy the FK. Tenancy.id is a
    // single-column primary key, so we can only have one tenancy with
    // this id globally — that's fine; the cases reference the same
    // tenancy row.
    await prisma.tenancy.upsert({
      where: { id: 'tenancy-cross-org' },
      create: {
        id: 'tenancy-cross-org',
        organisationId: ORG_ID,
        propertyId: 'prop-cross',
        status: 'ACTIVE',
        lastSyncedAt: new Date(),
      },
      update: {},
    });

    const a = await prisma.case.create({
      data: {
        organisationId: ORG_ID,
        tenancyId: 'tenancy-cross-org',
        status: 'ACTIVE',
        openedAt: new Date(),
        lastKnownBalancePence: 0n,
        lastKnownBalanceAt: new Date(),
      },
    });
    const b = await prisma.case.create({
      data: {
        organisationId: OTHER_ORG,
        tenancyId: 'tenancy-cross-org',
        status: 'ACTIVE',
        openedAt: new Date(),
        lastKnownBalancePence: 0n,
        lastKnownBalanceAt: new Date(),
      },
    });
    expect(a.id).not.toBe(b.id);

    // Cleanup so the next test sees a fresh state.
    await prisma.case.deleteMany({
      where: { tenancyId: 'tenancy-cross-org' },
    });
    await prisma.tenancy.deleteMany({ where: { id: 'tenancy-cross-org' } });
    await prisma.organisation.deleteMany({ where: { id: OTHER_ORG } });
  });
});

describe('CasesService — recomputeBalance', () => {
  it('returns 0n when the case has no charges', async () => {
    const svc = makeService();
    const { caseId } = await svc.openOrAttach(ORG_ID, 'tenancy-g');
    expect(await svc.recomputeBalance(caseId)).toBe(0n);
  });

  it('sums lastKnownRemainAmountPence across the case', async () => {
    const svc = makeService();
    const { caseId } = await svc.openOrAttach(ORG_ID, 'tenancy-h');
    await attachCharge(caseId, 'inv-h-1', 60_000n);
    await attachCharge(caseId, 'inv-h-2', 120_000n, 'PARTIALLY_PAID');
    expect(await svc.recomputeBalance(caseId)).toBe(180_000n);
  });
});

describe('CasesService — R2 case closes', () => {
  it('does not close when at least one charge is still outstanding', async () => {
    const svc = makeService();
    const { caseId } = await svc.openOrAttach(ORG_ID, 'tenancy-i');
    await attachCharge(caseId, 'inv-i-1', 0n, 'PAID');
    await attachCharge(caseId, 'inv-i-2', 50_000n, 'PARTIALLY_PAID');
    const r = await svc.recomputeAndMaybeClose(caseId);
    expect(r.closed).toBe(false);
    expect(r.balancePence).toBe(50_000n);
    const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(row.status).toBe('ACTIVE');
    expect(row.lastKnownBalancePence).toBe(50_000n);
  });

  it('closes when every charge is in a final state and balance is 0', async () => {
    const svc = makeService();
    const { caseId } = await svc.openOrAttach(ORG_ID, 'tenancy-j');
    await attachCharge(caseId, 'inv-j-1', 0n, 'PAID');
    await attachCharge(caseId, 'inv-j-2', 0n, 'RECONCILED');
    const r = await svc.recomputeAndMaybeClose(caseId);
    expect(r.closed).toBe(true);
    expect(r.balancePence).toBe(0n);
    const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(row.status).toBe('CLOSED');
    expect(row.closedAt).not.toBeNull();
    const events = await prisma.caseEvent.findMany({ where: { caseId } });
    expect(events.map((e) => e.kind)).toEqual(['CASE_OPENED', 'CASE_CLOSED']);
  });

  it('R2.2 cascade: closing the case marks pending chase entries skipped and rejects pending drafts', async () => {
    const svc = makeService();
    const { caseId } = await svc.openOrAttach(ORG_ID, 'tenancy-k');
    await attachCharge(caseId, 'inv-k-1', 0n, 'PAID');

    const chargeId = (await prisma.charge.findFirstOrThrow({ where: { caseId } })).id;
    await prisma.chaseScheduleEntry.create({
      data: {
        caseId,
        chargeId,
        stage: 'AWAITING_WD3',
        dueAt: new Date(),
      },
    });
    await prisma.communication.create({
      data: {
        caseId,
        organisationId: ORG_ID,
        direction: 'OUTBOUND',
        channel: 'EMAIL',
        status: 'AWAITING_APPROVAL',
        subject: 'pending draft',
      },
    });

    await svc.recomputeAndMaybeClose(caseId);

    const entry = await prisma.chaseScheduleEntry.findFirstOrThrow({ where: { caseId } });
    expect(entry.skippedReason).toBe('CASE_CLOSED');
    expect(entry.firedAt).not.toBeNull();

    const draft = await prisma.communication.findFirstOrThrow({ where: { caseId } });
    expect(draft.status).toBe('AUTO_REJECTED');
    expect(draft.rejectionReason).toBe('case closed');
  });

  it('idempotent: calling recomputeAndMaybeClose twice on a closed case is a no-op', async () => {
    const svc = makeService();
    const { caseId } = await svc.openOrAttach(ORG_ID, 'tenancy-l');
    await attachCharge(caseId, 'inv-l-1', 0n, 'PAID');
    await svc.recomputeAndMaybeClose(caseId);
    const second = await svc.recomputeAndMaybeClose(caseId);
    expect(second.closed).toBe(false); // already closed; not a fresh transition
    const events = await prisma.caseEvent.findMany({ where: { caseId } });
    // exactly one CASE_CLOSED, not two
    expect(events.filter((e) => e.kind === 'CASE_CLOSED')).toHaveLength(1);
  });

  it('does not close a case with zero balance but no charges', async () => {
    const svc = makeService();
    const { caseId } = await svc.openOrAttach(ORG_ID, 'tenancy-m');
    const r = await svc.recomputeAndMaybeClose(caseId);
    expect(r.closed).toBe(false);
  });
});

describe('CasesService — setHandler', () => {
  it('assigns + emits HANDLER_ASSIGNED with actor and payload', async () => {
    const svc = makeService();
    const { caseId } = await svc.openOrAttach(ORG_ID, 'tenancy-a');

    const r = await svc.setHandler({
      caseId,
      handlerUserId: 'user-alice',
      actorUserId: 'user-alice',
    });
    expect(r.handlerUserId).toBe('user-alice');

    const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(c.handlerUserId).toBe('user-alice');

    const events = await prisma.caseEvent.findMany({
      where: { caseId, kind: 'HANDLER_ASSIGNED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBe('user-alice');
    expect(events[0]!.payloadJson).toMatchObject({
      previousHandlerUserId: null,
      handlerUserId: 'user-alice',
    });
  });

  it('unassign clears the column and records the transition in the timeline', async () => {
    const svc = makeService();
    const { caseId } = await svc.openOrAttach(ORG_ID, 'tenancy-b');
    await svc.setHandler({ caseId, handlerUserId: 'user-alice', actorUserId: 'user-alice' });

    await svc.setHandler({ caseId, handlerUserId: null, actorUserId: 'user-bob' });

    const c = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(c.handlerUserId).toBeNull();

    const events = await prisma.caseEvent.findMany({
      where: { caseId, kind: 'HANDLER_ASSIGNED' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events).toHaveLength(2);
    expect(events[1]!.actorUserId).toBe('user-bob');
    expect(events[1]!.payloadJson).toMatchObject({
      previousHandlerUserId: 'user-alice',
      handlerUserId: null,
    });
  });

  it('no-op when the handler is already the target (no duplicate event)', async () => {
    const svc = makeService();
    const { caseId } = await svc.openOrAttach(ORG_ID, 'tenancy-c');
    await svc.setHandler({ caseId, handlerUserId: 'user-alice', actorUserId: 'user-alice' });
    await svc.setHandler({ caseId, handlerUserId: 'user-alice', actorUserId: 'user-alice' });

    const events = await prisma.caseEvent.findMany({
      where: { caseId, kind: 'HANDLER_ASSIGNED' },
    });
    expect(events).toHaveLength(1);
  });
});

describe('CasesService — list surfaces tenants + handler + last-actor', () => {
  it('exposes handlerUserId and the derived lastActorUserId', async () => {
    const svc = makeService();
    const { caseId } = await svc.openOrAttach(ORG_ID, 'tenancy-d');

    // Two events with actors; the latest one is the lastActor.
    await prisma.caseEvent.create({
      data: {
        caseId,
        kind: 'COMMUNICATION_APPROVED',
        actorUserId: 'user-bob',
        occurredAt: new Date('2026-05-20T10:00:00Z'),
        payloadJson: {},
      },
    });
    await prisma.caseEvent.create({
      data: {
        caseId,
        kind: 'COMMUNICATION_APPROVED',
        actorUserId: 'user-alice',
        occurredAt: new Date('2026-05-22T10:00:00Z'),
        payloadJson: {},
      },
    });
    await svc.setHandler({
      caseId,
      handlerUserId: 'user-carol',
      actorUserId: 'user-carol',
    });

    const rows = await svc.list(ORG_ID);
    const row = rows.find((r) => r.id === caseId);
    expect(row).toBeDefined();
    expect(row!.handlerUserId).toBe('user-carol');
    // setHandler also wrote an event with actorUserId=user-carol, which is
    // the most recent — that's the "last actor" surface.
    expect(row!.lastActorUserId).toBe('user-carol');
    expect(row!.lastActorAt).not.toBeNull();
  });

  it('reports null lastActor when no event has an actor', async () => {
    const svc = makeService();
    const { caseId } = await svc.openOrAttach(ORG_ID, 'tenancy-e');
    const rows = await svc.list(ORG_ID);
    const row = rows.find((r) => r.id === caseId);
    expect(row!.handlerUserId).toBeNull();
    expect(row!.lastActorUserId).toBeNull();
    expect(row!.lastActorAt).toBeNull();
  });
});
