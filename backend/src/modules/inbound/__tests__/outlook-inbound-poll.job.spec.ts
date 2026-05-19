import { PrismaClient } from '@prisma/client';
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
import { Clock } from '../../../common/clock/clock.service';
import { NotImplementedAnthropicClient } from '../../../integrations/anthropic/anthropic-client';
import type {
  InboundMailReader,
  InboundMessageFull,
  InboundMessageSummary,
} from '../../../integrations/outlook/outlook.types';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';
import { PreFilterService } from '../../ai/pre-filter.service';
import { PassThroughRedactor } from '../../ai/redactor';
import { BreathingSpaceService } from '../../cases/breathing-space.service';
import { S8EvaluationService } from '../../cases/s8-evaluation.service';
import { InboundCursorService } from '../inbound-cursor.service';
import { InboundPipelineService } from '../inbound-pipeline.service';
import { InboundSenderMatcher } from '../inbound-sender-matcher.service';
import { OutlookInboundPollJob } from '../jobs/outlook-inbound-poll.job';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const ORG_A = 'inbound-poll-org-a';
const ORG_B = 'inbound-poll-org-b';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

async function wipe(): Promise<void> {
  await prisma.outlookPollCursor.deleteMany({});
  await prisma.orphanInbound.deleteMany({});
  await prisma.classificationResult.deleteMany({
    where: { case: { organisationId: { in: [ORG_A, ORG_B] } } },
  });
  await prisma.reviewQueueItem.deleteMany({
    where: { organisationId: { in: [ORG_A, ORG_B] } },
  });
  await prisma.escalationFlag.deleteMany({
    where: { case: { organisationId: { in: [ORG_A, ORG_B] } } },
  });
  await prisma.chaseScheduleEntry.deleteMany({
    where: { case: { organisationId: { in: [ORG_A, ORG_B] } } },
  });
  await prisma.caseEvent.deleteMany({
    where: { case: { organisationId: { in: [ORG_A, ORG_B] } } },
  });
  await prisma.communication.deleteMany({
    where: { organisationId: { in: [ORG_A, ORG_B] } },
  });
  await prisma.tenancyContact.deleteMany({
    where: { tenancy: { organisationId: { in: [ORG_A, ORG_B] } } },
  });
  await prisma.case.deleteMany({ where: { organisationId: { in: [ORG_A, ORG_B] } } });
  await prisma.contact.deleteMany({ where: { organisationId: { in: [ORG_A, ORG_B] } } });
  await prisma.tenancy.deleteMany({ where: { organisationId: { in: [ORG_A, ORG_B] } } });
  await prisma.organisation.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
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
  await wipe();
  await prisma.organisation.create({ data: { id: ORG_A, name: 'Org A' } });
  await prisma.organisation.create({ data: { id: ORG_B, name: 'Org B' } });
});

afterEach(async () => {
  await wipe();
  vi.restoreAllMocks();
});

interface SeedActiveCaseArgs {
  organisationId: string;
  tenancyId: string;
  contactId: string;
  email: string;
}

async function seedActiveCase(args: SeedActiveCaseArgs): Promise<string> {
  await prisma.tenancy.create({
    data: {
      id: args.tenancyId,
      organisationId: args.organisationId,
      propertyId: 'p',
      status: 'ACTIVE',
      lastSyncedAt: new Date(),
    },
  });
  await prisma.contact.create({
    data: {
      id: args.contactId,
      organisationId: args.organisationId,
      primaryEmail: args.email.toLowerCase(),
      emailsJson: [],
      phonesJson: [],
      lastSyncedAt: new Date(),
    },
  });
  await prisma.tenancyContact.create({
    data: { tenancyId: args.tenancyId, contactId: args.contactId, role: 'TENANT' },
  });
  const c = await prisma.case.create({
    data: {
      organisationId: args.organisationId,
      tenancyId: args.tenancyId,
      status: 'ACTIVE',
      openedAt: new Date('2026-01-01T00:00:00Z'),
      lastKnownBalancePence: 50000n,
      lastKnownBalanceAt: new Date(),
    },
  });
  return c.id;
}

function makeFakeOutlook(messages: InboundMessageFull[]): InboundMailReader & {
  listInbound: ReturnType<typeof vi.fn>;
  getMessage: ReturnType<typeof vi.fn>;
  markRead: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
} {
  const byId = new Map(messages.map((m) => [m.outlookMessageId, m]));
  const summaries: InboundMessageSummary[] = messages.map((m) => ({
    outlookMessageId: m.outlookMessageId,
    fromAddress: m.fromAddress,
    subject: m.subject,
    receivedAt: m.receivedAt,
    bodyPreview: m.bodyPreview,
  }));
  return {
    listInbound: vi.fn(async () => summaries),
    getMessage: vi.fn(async (id: string) => {
      const m = byId.get(id);
      if (!m) throw new Error(`unknown message ${id}`);
      return m;
    }),
    markRead: vi.fn(async () => undefined),
    moveTo: vi.fn(async () => undefined),
  };
}

function makeJob(
  outlook: InboundMailReader,
  clockNow = new Date('2026-05-15T12:00:00Z'),
  pipelineSpy: ReturnType<typeof vi.fn> = vi.fn(async () => undefined),
): { job: OutlookInboundPollJob; pipeline: InboundPipelineService } {
  const clock = new Clock();
  vi.spyOn(clock, 'now').mockReturnValue(clockNow);
  const cursor = new InboundCursorService(prisma as unknown as PrismaService);
  const matcher = new InboundSenderMatcher(prisma as unknown as PrismaService);
  const s8 = new S8EvaluationService(prisma as unknown as PrismaService);
  const breathingSpace = new BreathingSpaceService(prisma as unknown as PrismaService, s8);
  const pipeline = new InboundPipelineService(
    prisma as unknown as PrismaService,
    clock,
    new PreFilterService(),
    new NotImplementedAnthropicClient(),
    new PassThroughRedactor(),
    breathingSpace,
  );
  // Poll-job tests stub the pipeline by default — the pipeline has its
  // own spec. Tests that care about the spy's invocation pass an
  // explicit one.
  vi.spyOn(pipeline, 'handle').mockImplementation(pipelineSpy);
  const job = new OutlookInboundPollJob(
    prisma as unknown as PrismaService,
    clock,
    cursor,
    matcher,
    pipeline,
    outlook,
  );
  return { job, pipeline };
}

function makeFullMessage(opts: Partial<InboundMessageFull> & { id: string }): InboundMessageFull {
  return {
    outlookMessageId: opts.id,
    fromAddress: opts.fromAddress ?? 'jane@example.com',
    subject: opts.subject ?? 'Test subject',
    receivedAt: opts.receivedAt ?? new Date('2026-05-15T11:45:00Z'),
    bodyText: opts.bodyText ?? 'Plain text body',
    bodyHtml: opts.bodyHtml ?? null,
    bodyPreview: opts.bodyPreview ?? undefined,
  };
}

describe('OutlookInboundPollJob.runOnce — empty mailbox', () => {
  it('returns COMPLETED with zero counts and stamps lastPolledAt', async () => {
    const outlook = makeFakeOutlook([]);
    const polledAt = new Date('2026-05-15T12:00:00Z');
    const { job } = makeJob(outlook, polledAt);

    const result = await job.runOnce();

    expect(result.status).toBe('COMPLETED');
    expect(result.processed).toBe(0);
    expect(result.newCommunications).toBe(0);
    expect(result.cursorAdvancedTo).toBeNull();
    expect(outlook.listInbound).toHaveBeenCalledTimes(1);
    // listInbound called with floor: now − 24h
    const callArg = (outlook.listInbound as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Date;
    expect(callArg.toISOString()).toBe('2026-05-14T12:00:00.000Z');

    const cursor = await prisma.outlookPollCursor.findUnique({ where: { id: 'singleton' } });
    expect(cursor?.lastPolledAt?.toISOString()).toBe(polledAt.toISOString());
    expect(cursor?.lastReceivedAt).toBeNull();
  });
});

describe('OutlookInboundPollJob.runOnce — matched + active case', () => {
  it('creates an inbound Communication, emits COMMUNICATION_RECEIVED, invokes pipeline, advances cursor', async () => {
    const caseId = await seedActiveCase({
      organisationId: ORG_A,
      tenancyId: 'tn-1',
      contactId: 'c-1',
      email: 'jane@example.com',
    });
    const msg = makeFullMessage({
      id: 'outlook-msg-1',
      fromAddress: 'Jane@Example.com',
      subject: 'Re: rent',
      receivedAt: new Date('2026-05-15T11:45:00Z'),
      bodyText: "I'll pay on Friday",
    });
    const outlook = makeFakeOutlook([msg]);
    const pipelineSpy = vi.fn(async () => undefined);
    const { job } = makeJob(outlook, new Date('2026-05-15T12:00:00Z'), pipelineSpy);

    const result = await job.runOnce();

    expect(result.status).toBe('COMPLETED');
    expect(result.processed).toBe(1);
    expect(result.newCommunications).toBe(1);
    expect(result.attachedToClosedCase).toBe(0);
    expect(result.orphansUnmatched).toBe(0);
    expect(result.cursorAdvancedTo).toBe('2026-05-15T11:45:00.000Z');

    const comms = await prisma.communication.findMany({
      where: { organisationId: ORG_A },
    });
    expect(comms).toHaveLength(1);
    const [comm] = comms;
    expect(comm!.caseId).toBe(caseId);
    expect(comm!.direction).toBe('INBOUND');
    expect(comm!.status).toBe('RECEIVED');
    expect(comm!.outlookMessageId).toBe('outlook-msg-1');
    expect(comm!.fromAddress).toBe('Jane@Example.com');
    expect(comm!.rawBodyText).toBe("I'll pay on Friday");

    const events = await prisma.caseEvent.findMany({
      where: { caseId, kind: 'COMMUNICATION_RECEIVED' },
    });
    expect(events).toHaveLength(1);

    expect(outlook.markRead).toHaveBeenCalledWith('outlook-msg-1');
    expect(pipelineSpy).toHaveBeenCalledTimes(1);
    expect(pipelineSpy).toHaveBeenCalledWith(comm!.id);
  });

  it('is idempotent: re-running with the same outlookMessageId does not duplicate', async () => {
    await seedActiveCase({
      organisationId: ORG_A,
      tenancyId: 'tn-1',
      contactId: 'c-1',
      email: 'jane@example.com',
    });
    const msg = makeFullMessage({ id: 'outlook-msg-1' });
    const outlook = makeFakeOutlook([msg]);
    const { job } = makeJob(outlook);

    await job.runOnce();
    const r2 = await job.runOnce();

    expect(r2.processed).toBe(1);
    expect(r2.newCommunications).toBe(0);
    expect(r2.duplicatesSkipped).toBe(1);
    expect(
      await prisma.communication.count({ where: { organisationId: ORG_A } }),
    ).toBe(1);
  });

  it('continues ingestion even if markRead fails (best-effort)', async () => {
    await seedActiveCase({
      organisationId: ORG_A,
      tenancyId: 'tn-1',
      contactId: 'c-1',
      email: 'jane@example.com',
    });
    const msg = makeFullMessage({ id: 'outlook-msg-1' });
    const outlook = makeFakeOutlook([msg]);
    (outlook.markRead as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('graph: forbidden'),
    );
    const { job } = makeJob(outlook);

    const result = await job.runOnce();
    expect(result.newCommunications).toBe(1);
    expect(await prisma.communication.count({ where: { organisationId: ORG_A } })).toBe(1);
  });
});

describe('OutlookInboundPollJob.runOnce — sender match edge cases', () => {
  it('persists an orphan with UNMATCHED_SENDER when no contact matches', async () => {
    const msg = makeFullMessage({
      id: 'outlook-msg-orphan',
      fromAddress: 'stranger@example.com',
    });
    const outlook = makeFakeOutlook([msg]);
    const pipelineSpy = vi.fn(async () => undefined);
    const { job } = makeJob(outlook, new Date('2026-05-15T12:00:00Z'), pipelineSpy);

    const result = await job.runOnce();
    expect(result.orphansUnmatched).toBe(1);
    expect(result.newCommunications).toBe(0);
    expect(pipelineSpy).not.toHaveBeenCalled();

    const orphan = await prisma.orphanInbound.findUnique({
      where: { outlookMessageId: 'outlook-msg-orphan' },
    });
    expect(orphan?.reasonKind).toBe('UNMATCHED_SENDER');
    expect(orphan?.fromAddress).toBe('stranger@example.com');
    expect(orphan?.matchedContactsJson).toBeNull();
  });

  it('persists an orphan with AMBIGUOUS_SENDER when the email matches across orgs', async () => {
    await seedActiveCase({
      organisationId: ORG_A,
      tenancyId: 'tn-a',
      contactId: 'c-a',
      email: 'shared@example.com',
    });
    await seedActiveCase({
      organisationId: ORG_B,
      tenancyId: 'tn-b',
      contactId: 'c-b',
      email: 'shared@example.com',
    });
    const msg = makeFullMessage({
      id: 'outlook-msg-ambiguous',
      fromAddress: 'shared@example.com',
    });
    const outlook = makeFakeOutlook([msg]);
    const pipelineSpy = vi.fn(async () => undefined);
    const { job } = makeJob(outlook, new Date('2026-05-15T12:00:00Z'), pipelineSpy);

    const result = await job.runOnce();
    expect(result.orphansAmbiguous).toBe(1);
    expect(pipelineSpy).not.toHaveBeenCalled();

    const orphan = await prisma.orphanInbound.findUnique({
      where: { outlookMessageId: 'outlook-msg-ambiguous' },
    });
    expect(orphan?.reasonKind).toBe('AMBIGUOUS_SENDER');
    const matched = orphan?.matchedContactsJson as Array<{
      contactId: string;
      organisationId: string;
    }> | null;
    expect(matched).not.toBeNull();
    expect(matched!.map((c) => c.organisationId).sort()).toEqual([ORG_A, ORG_B]);

    // No Communication created
    expect(await prisma.communication.count()).toBe(0);
  });

  it('persists an orphan when the matched contact has no cases at all', async () => {
    await prisma.contact.create({
      data: {
        id: 'c-no-case',
        organisationId: ORG_A,
        primaryEmail: 'nocase@example.com',
        emailsJson: [],
        phonesJson: [],
        lastSyncedAt: new Date(),
      },
    });
    const msg = makeFullMessage({
      id: 'outlook-msg-nocase',
      fromAddress: 'nocase@example.com',
    });
    const outlook = makeFakeOutlook([msg]);
    const pipelineSpy = vi.fn(async () => undefined);
    const { job } = makeJob(outlook, new Date('2026-05-15T12:00:00Z'), pipelineSpy);

    const result = await job.runOnce();
    expect(result.orphansNoCase).toBe(1);
    expect(pipelineSpy).not.toHaveBeenCalled();

    const orphan = await prisma.orphanInbound.findUnique({
      where: { outlookMessageId: 'outlook-msg-nocase' },
    });
    expect(orphan?.reasonKind).toBe('UNMATCHED_SENDER');
    expect(orphan?.matchedContactsJson).toEqual([
      { contactId: 'c-no-case', organisationId: ORG_A },
    ]);
  });

  it('attaches to a closed case and skips the AI pipeline when no active case exists', async () => {
    await prisma.tenancy.create({
      data: {
        id: 'tn-closed',
        organisationId: ORG_A,
        propertyId: 'p',
        status: 'ACTIVE',
        lastSyncedAt: new Date(),
      },
    });
    await prisma.contact.create({
      data: {
        id: 'c-closed',
        organisationId: ORG_A,
        primaryEmail: 'closed@example.com',
        emailsJson: [],
        phonesJson: [],
        lastSyncedAt: new Date(),
      },
    });
    await prisma.tenancyContact.create({
      data: { tenancyId: 'tn-closed', contactId: 'c-closed', role: 'TENANT' },
    });
    const closedCase = await prisma.case.create({
      data: {
        organisationId: ORG_A,
        tenancyId: 'tn-closed',
        status: 'CLOSED',
        openedAt: new Date('2026-01-01T00:00:00Z'),
        closedAt: new Date('2026-02-01T00:00:00Z'),
        lastKnownBalancePence: 0n,
        lastKnownBalanceAt: new Date(),
      },
    });

    const msg = makeFullMessage({
      id: 'outlook-msg-closed',
      fromAddress: 'closed@example.com',
    });
    const outlook = makeFakeOutlook([msg]);
    const pipelineSpy = vi.fn(async () => undefined);
    const { job } = makeJob(outlook, new Date('2026-05-15T12:00:00Z'), pipelineSpy);

    const result = await job.runOnce();
    expect(result.newCommunications).toBe(1);
    expect(result.attachedToClosedCase).toBe(1);
    expect(pipelineSpy).not.toHaveBeenCalled();

    const comm = await prisma.communication.findUniqueOrThrow({
      where: { outlookMessageId: 'outlook-msg-closed' },
    });
    expect(comm.caseId).toBe(closedCase.id);
    expect(comm.status).toBe('RECEIVED');

    const event = await prisma.caseEvent.findFirstOrThrow({
      where: { caseId: closedCase.id, kind: 'COMMUNICATION_RECEIVED' },
    });
    const payload = event.payloadJson as { attachedToClosedCase: boolean };
    expect(payload.attachedToClosedCase).toBe(true);
  });
});

describe('OutlookInboundPollJob.runOnce — cursor', () => {
  it('subtracts a 2-min overlap on the next poll after lastReceivedAt is set', async () => {
    await seedActiveCase({
      organisationId: ORG_A,
      tenancyId: 'tn-1',
      contactId: 'c-1',
      email: 'jane@example.com',
    });
    const msg = makeFullMessage({
      id: 'outlook-msg-1',
      receivedAt: new Date('2026-05-15T11:45:00Z'),
    });
    const outlook = makeFakeOutlook([msg]);
    const { job } = makeJob(outlook, new Date('2026-05-15T12:00:00Z'));
    await job.runOnce();

    // Second poll: empty inbox, but the listInbound `since` should be
    // lastReceivedAt − 2 min = 11:43.
    (outlook.listInbound as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await job.runOnce();
    const secondSince = (outlook.listInbound as ReturnType<typeof vi.fn>).mock
      .calls[1]![0] as Date;
    expect(secondSince.toISOString()).toBe('2026-05-15T11:43:00.000Z');
  });
});
