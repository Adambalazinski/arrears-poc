import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import type { AnthropicClient } from '../../../integrations/anthropic/anthropic-client';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';
import type { HardTriggerKind } from '../../ai/hard-triggers';
import { PreFilterService } from '../../ai/pre-filter.service';
import { InboundPipelineService } from '../inbound-pipeline.service';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const ORG = 'inbound-pipeline-org';
const FIXTURE_DIR = path.resolve(__dirname, '../../../../../fixtures/outlook');

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

async function wipe(): Promise<void> {
  await prisma.classificationResult.deleteMany({
    where: { case: { organisationId: ORG } },
  });
  await prisma.reviewQueueItem.deleteMany({ where: { organisationId: ORG } });
  await prisma.escalationFlag.deleteMany({
    where: { case: { organisationId: ORG } },
  });
  await prisma.chaseScheduleEntry.deleteMany({
    where: { case: { organisationId: ORG } },
  });
  await prisma.caseEvent.deleteMany({ where: { case: { organisationId: ORG } } });
  await prisma.communication.deleteMany({ where: { organisationId: ORG } });
  await prisma.charge.deleteMany({ where: { organisationId: ORG } });
  await prisma.tenancyContact.deleteMany({
    where: { tenancy: { organisationId: ORG } },
  });
  await prisma.case.deleteMany({ where: { organisationId: ORG } });
  await prisma.contact.deleteMany({ where: { organisationId: ORG } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG } });
  await prisma.organisation.deleteMany({ where: { id: ORG } });
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
  await prisma.organisation.create({ data: { id: ORG, name: 'Pipeline test org' } });
});

afterEach(async () => {
  await wipe();
  vi.restoreAllMocks();
});

interface ParsedEml {
  fromAddress: string;
  subject: string | null;
  bodyText: string;
}

function parseEml(raw: string): ParsedEml {
  const separatorIdx = raw.indexOf('\n\n');
  const headerBlock = separatorIdx >= 0 ? raw.slice(0, separatorIdx) : raw;
  const body = separatorIdx >= 0 ? raw.slice(separatorIdx + 2) : '';
  const headers = new Map<string, string>();
  for (const line of headerBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return {
    fromAddress: headers.get('from') ?? '',
    subject: headers.get('subject') ?? null,
    bodyText: body.trim(),
  };
}

function loadFixture(name: string): ParsedEml {
  return parseEml(readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function makeAnthropicSpy(): {
  client: AnthropicClient;
  classify: ReturnType<typeof vi.fn>;
  draftReply: ReturnType<typeof vi.fn>;
} {
  const classify = vi.fn(async () => {
    throw new Error('AnthropicClient.classify must not be called for hard-trigger paths');
  });
  const draftReply = vi.fn(async () => {
    throw new Error('AnthropicClient.draftReply must not be called for hard-trigger paths');
  });
  return {
    client: {
      classify,
      draftReply,
    } as unknown as AnthropicClient,
    classify,
    draftReply,
  };
}

interface SeedCaseResult {
  caseId: string;
  tenancyId: string;
}

async function seedActiveCaseWithChaseEntries(): Promise<SeedCaseResult> {
  const tenancyId = 'tenancy-pipeline-001';
  await prisma.tenancy.create({
    data: {
      id: tenancyId,
      organisationId: ORG,
      propertyId: 'prop',
      status: 'ACTIVE',
      lastSyncedAt: new Date(),
    },
  });
  const c = await prisma.case.create({
    data: {
      organisationId: ORG,
      tenancyId,
      status: 'ACTIVE',
      openedAt: new Date('2026-04-01T00:00:00Z'),
      lastKnownBalancePence: 200000n,
      lastKnownBalanceAt: new Date(),
    },
  });
  const charge = await prisma.charge.create({
    data: {
      caseId: c.id,
      organisationId: ORG,
      lwcaInvoiceId: 'lwca-pipeline-001',
      dueDate: new Date('2026-04-01T00:00:00Z'),
      invoiceDate: new Date('2026-04-01T00:00:00Z'),
      grossAmountPence: 200000n,
      lastKnownRemainAmountPence: 200000n,
      lastKnownStatus: 'UNPAID',
      lastSyncedAt: new Date(),
    },
  });
  // Two pending chase entries that the hard-trigger flow should halt.
  await prisma.chaseScheduleEntry.create({
    data: {
      caseId: c.id,
      chargeId: charge.id,
      stage: 'WD5_SENT',
      dueAt: new Date('2026-05-20T09:00:00Z'),
    },
  });
  await prisma.chaseScheduleEntry.create({
    data: {
      caseId: c.id,
      chargeId: charge.id,
      stage: 'WD8_SENT',
      dueAt: new Date('2026-05-25T09:00:00Z'),
    },
  });
  // And one already-fired entry to confirm the flow doesn't touch it.
  await prisma.chaseScheduleEntry.create({
    data: {
      caseId: c.id,
      chargeId: charge.id,
      stage: 'WD3_SENT',
      dueAt: new Date('2026-05-10T09:00:00Z'),
      firedAt: new Date('2026-05-10T09:00:01Z'),
    },
  });
  return { caseId: c.id, tenancyId };
}

async function seedInboundCommunication(opts: {
  caseId: string;
  subject: string | null;
  bodyText: string;
  fromAddress: string;
}): Promise<string> {
  const comm = await prisma.communication.create({
    data: {
      caseId: opts.caseId,
      organisationId: ORG,
      direction: 'INBOUND',
      channel: 'EMAIL',
      status: 'RECEIVED',
      fromAddress: opts.fromAddress,
      receivedAt: new Date('2026-05-18T09:00:00Z'),
      outlookMessageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
      subject: opts.subject,
      rawBodyText: opts.bodyText,
    },
  });
  return comm.id;
}

function makePipeline(anthropic: AnthropicClient): InboundPipelineService {
  return new InboundPipelineService(
    prisma as unknown as PrismaService,
    new Clock(),
    new PreFilterService(),
    anthropic,
  );
}

interface HardTriggerCase {
  fixture: string;
  expectedTrigger: HardTriggerKind;
}

const HARD_TRIGGER_CASES: HardTriggerCase[] = [
  { fixture: 'inbound-hardship.eml', expectedTrigger: 'HARDSHIP_INDICATED' },
  { fixture: 'inbound-mental-health.eml', expectedTrigger: 'MENTAL_HEALTH_INDICATED' },
  { fixture: 'inbound-breathing-space.eml', expectedTrigger: 'BREATHING_SPACE' },
  { fixture: 'inbound-third-party.eml', expectedTrigger: 'THIRD_PARTY_INVOLVED' },
  { fixture: 'inbound-dispute.eml', expectedTrigger: 'LIABILITY_DISPUTED' },
  { fixture: 'inbound-domestic.eml', expectedTrigger: 'DOMESTIC_CIRCUMSTANCES' },
];

const ROUTINE_FIXTURES = [
  'inbound-routine-promise.eml',
  'inbound-payment-confirmed.eml',
  'inbound-query.eml',
];

describe('InboundPipelineService — hard-trigger fixtures', () => {
  for (const { fixture, expectedTrigger } of HARD_TRIGGER_CASES) {
    it(`${fixture} raises ${expectedTrigger}, halts cadence, never calls Anthropic`, async () => {
      const seed = await seedActiveCaseWithChaseEntries();
      const eml = loadFixture(fixture);
      const commId = await seedInboundCommunication({
        caseId: seed.caseId,
        subject: eml.subject,
        bodyText: eml.bodyText,
        fromAddress: eml.fromAddress,
      });
      const anthropic = makeAnthropicSpy();
      const pipeline = makePipeline(anthropic.client);

      const outcome = await pipeline.handle(commId);

      expect(outcome.status).toBe('HARD_TRIGGER');
      if (outcome.status === 'HARD_TRIGGER') {
        expect(outcome.trigger).toBe(expectedTrigger);
        expect(outcome.keyword).toBeTruthy();
      }

      // ClassificationResult: pre-filter only, no LLM fields populated
      const cr = await prisma.classificationResult.findUniqueOrThrow({
        where: { communicationId: commId },
      });
      expect(cr.preFilterMatched).toBe(true);
      expect(cr.preFilterTriggerKind).toBe(expectedTrigger);
      expect(cr.preFilterMatchedKeyword).toBeTruthy();
      expect(cr.modelUsed).toBeNull();
      expect(cr.sentiment).toBeNull();
      expect(cr.intent).toBeNull();

      // EscalationFlag of the matching kind, still raised (resolvedAt null)
      const flags = await prisma.escalationFlag.findMany({
        where: { caseId: seed.caseId },
      });
      expect(flags).toHaveLength(1);
      expect(flags[0]!.kind).toBe(expectedTrigger);
      expect(flags[0]!.resolvedAt).toBeNull();

      // URGENT review-queue item, linked to the inbound communication
      const rqi = await prisma.reviewQueueItem.findFirstOrThrow({
        where: { caseId: seed.caseId, kind: 'HARD_TRIGGER_ESCALATION' },
      });
      expect(rqi.priority).toBe('URGENT');
      expect(rqi.communicationId).toBe(commId);
      expect(rqi.resolvedAt).toBeNull();

      // Timeline: HARD_TRIGGER_MATCHED + ESCALATION_FLAG_RAISED present
      const triggerEvent = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId: seed.caseId, kind: 'HARD_TRIGGER_MATCHED' },
      });
      const triggerPayload = triggerEvent.payloadJson as Record<string, unknown>;
      expect(triggerPayload.triggerKind).toBe(expectedTrigger);
      expect(triggerPayload.communicationId).toBe(commId);

      const flagEvent = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId: seed.caseId, kind: 'ESCALATION_FLAG_RAISED' },
      });
      expect((flagEvent.payloadJson as Record<string, unknown>).kind).toBe(
        expectedTrigger,
      );

      // Case marked awaiting handler action
      const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: seed.caseId } });
      expect(caseRow.awaitingHandlerAction).toBe(true);

      // Chase track halted: two pending entries now firedAt + skippedReason,
      // pre-existing fired entry untouched.
      const entries = await prisma.chaseScheduleEntry.findMany({
        where: { caseId: seed.caseId },
        orderBy: { dueAt: 'asc' },
      });
      expect(entries).toHaveLength(3);
      const [wd3, wd5, wd8] = entries;
      expect(wd3!.stage).toBe('WD3_SENT');
      expect(wd3!.skippedReason).toBeNull(); // already-fired entry untouched
      expect(wd5!.firedAt).not.toBeNull();
      expect(wd5!.skippedReason).toBe('BREATHING_SPACE_ACTIVE');
      expect(wd8!.firedAt).not.toBeNull();
      expect(wd8!.skippedReason).toBe('BREATHING_SPACE_ACTIVE');

      // Communication flipped to PROCESSED
      const updated = await prisma.communication.findUniqueOrThrow({
        where: { id: commId },
      });
      expect(updated.status).toBe('PROCESSED');

      // SAFETY BOUNDARY — Anthropic must not have been invoked at all.
      expect(anthropic.classify).not.toHaveBeenCalled();
      expect(anthropic.draftReply).not.toHaveBeenCalled();
    });
  }
});

describe('InboundPipelineService — routine fixtures (no hard trigger)', () => {
  for (const fixture of ROUTINE_FIXTURES) {
    it(`${fixture} returns AWAITING_CLASSIFICATION with no escalation side-effects and zero Anthropic calls`, async () => {
      const seed = await seedActiveCaseWithChaseEntries();
      const eml = loadFixture(fixture);
      const commId = await seedInboundCommunication({
        caseId: seed.caseId,
        subject: eml.subject,
        bodyText: eml.bodyText,
        fromAddress: eml.fromAddress,
      });
      const anthropic = makeAnthropicSpy();
      const pipeline = makePipeline(anthropic.client);

      const outcome = await pipeline.handle(commId);
      expect(outcome.status).toBe('AWAITING_CLASSIFICATION');

      // None of the escalation side-effects applied.
      expect(await prisma.classificationResult.count()).toBe(0);
      expect(await prisma.escalationFlag.count()).toBe(0);
      expect(await prisma.reviewQueueItem.count()).toBe(0);
      expect(
        await prisma.caseEvent.count({
          where: { caseId: seed.caseId, kind: 'HARD_TRIGGER_MATCHED' },
        }),
      ).toBe(0);
      const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: seed.caseId } });
      expect(caseRow.awaitingHandlerAction).toBe(false);
      const pendingEntries = await prisma.chaseScheduleEntry.findMany({
        where: { caseId: seed.caseId, firedAt: null },
      });
      expect(pendingEntries).toHaveLength(2);

      // 7.3 leaves the Communication in RECEIVED — 7.6 will move it on.
      const comm = await prisma.communication.findUniqueOrThrow({
        where: { id: commId },
      });
      expect(comm.status).toBe('RECEIVED');

      // Anthropic still untouched — Phase 7.6 wires the call site.
      expect(anthropic.classify).not.toHaveBeenCalled();
      expect(anthropic.draftReply).not.toHaveBeenCalled();
    });
  }
});

describe('InboundPipelineService — edge cases', () => {
  it('returns NOT_FOUND when the communication id is unknown', async () => {
    const anthropic = makeAnthropicSpy();
    const pipeline = makePipeline(anthropic.client);
    const outcome = await pipeline.handle('00000000-0000-0000-0000-000000000000');
    expect(outcome.status).toBe('NOT_FOUND');
    expect(anthropic.classify).not.toHaveBeenCalled();
  });

  it('matches the most-severe trigger when multiple categories fire in one body', async () => {
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: 'Mixed signal',
      // "lost my job" → HARDSHIP, "I'm really struggling" → MENTAL_HEALTH
      // Expected: MENTAL_HEALTH_INDICATED wins on severity.
      bodyText:
        "I lost my job last month and now I'm really struggling with everything.",
      fromAddress: 'jane@example.com',
    });
    const anthropic = makeAnthropicSpy();
    const pipeline = makePipeline(anthropic.client);

    const outcome = await pipeline.handle(commId);
    expect(outcome.status).toBe('HARD_TRIGGER');
    if (outcome.status === 'HARD_TRIGGER') {
      expect(outcome.trigger).toBe('MENTAL_HEALTH_INDICATED');
    }
    expect(anthropic.classify).not.toHaveBeenCalled();
  });
});
