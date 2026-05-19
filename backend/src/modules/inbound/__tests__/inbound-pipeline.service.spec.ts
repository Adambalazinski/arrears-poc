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
import {
  AnthropicJsonParseError,
  AnthropicSpendCapExceeded,
  type AnthropicClassifyResult,
  type AnthropicClient,
  type AnthropicDraftResult,
} from '../../../integrations/anthropic/anthropic-client';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';
import type { HardTriggerKind } from '../../ai/hard-triggers';
import { PreFilterService } from '../../ai/pre-filter.service';
import { DefaultRedactor, RedactionRequiredError, type Redactor } from '../../ai/redactor';
import { BreathingSpaceService } from '../../cases/breathing-space.service';
import { S8EvaluationService } from '../../cases/s8-evaluation.service';
import {
  InboundPipelineService,
  type LowConfidenceReason,
} from '../inbound-pipeline.service';

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
  await prisma.organisationConfig.deleteMany({ where: { organisationId: ORG } });
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

function makeAnthropicHappyPath(opts: {
  classify?: Partial<AnthropicClassifyResult>;
  draft?: Partial<AnthropicDraftResult>;
} = {}): {
  client: AnthropicClient;
  classify: ReturnType<typeof vi.fn>;
  draftReply: ReturnType<typeof vi.fn>;
  classifyResult: AnthropicClassifyResult;
  draftResult: AnthropicDraftResult;
} {
  const classifyResult: AnthropicClassifyResult = {
    modelUsed: 'claude-haiku-4-5',
    sentiment: 'NEUTRAL',
    intent: 'PAYMENT_PROMISE',
    confidence: 0.82,
    rationale: 'tenant offers to pay on Friday',
    promptTokens: 540,
    completionTokens: 35,
    estimatedCostPence: 1,
    ...opts.classify,
  };
  const draftResult: AnthropicDraftResult = {
    modelUsed: 'claude-sonnet-4-6',
    bodyMarkdown:
      'Dear Jane,\n\nThanks for letting us know — your message has been received and a colleague will be in touch.\n\nBest regards,\nThe Lettings Team',
    promptTokens: 820,
    completionTokens: 110,
    estimatedCostPence: 1,
    ...opts.draft,
  };
  const classify = vi.fn(async () => classifyResult);
  const draftReply = vi.fn(async () => draftResult);
  return {
    client: { classify, draftReply } as unknown as AnthropicClient,
    classify,
    draftReply,
    classifyResult,
    draftResult,
  };
}

function makeFailingClassifier(err: Error): {
  client: AnthropicClient;
  classify: ReturnType<typeof vi.fn>;
  draftReply: ReturnType<typeof vi.fn>;
} {
  const classify = vi.fn(async () => {
    throw err;
  });
  const draftReply = vi.fn(async () => {
    throw new Error('draftReply should not run when classify fails');
  });
  return {
    client: { classify, draftReply } as unknown as AnthropicClient,
    classify,
    draftReply,
  };
}

function makeFailingDrafter(opts: {
  classify?: Partial<AnthropicClassifyResult>;
  draftError: Error;
}): {
  client: AnthropicClient;
  classify: ReturnType<typeof vi.fn>;
  draftReply: ReturnType<typeof vi.fn>;
} {
  const classifyResult: AnthropicClassifyResult = {
    modelUsed: 'claude-haiku-4-5',
    sentiment: 'NEUTRAL',
    intent: 'PAYMENT_PROMISE',
    confidence: 0.82,
    rationale: 'tenant offers to pay on Friday',
    promptTokens: 540,
    completionTokens: 35,
    estimatedCostPence: 1,
    ...opts.classify,
  };
  const classify = vi.fn(async () => classifyResult);
  const draftReply = vi.fn(async () => {
    throw opts.draftError;
  });
  return {
    client: { classify, draftReply } as unknown as AnthropicClient,
    classify,
    draftReply,
  };
}

interface SeedCaseResult {
  caseId: string;
  tenancyId: string;
  contactId: string;
}

interface SeedCaseOptions {
  /** Sender contact: linked to the case's tenancy so the matcher can resolve them. */
  contact?: { id?: string; firstName?: string; primaryEmail: string };
  workingDaysOverdue?: number;
}

async function seedActiveCaseWithChaseEntries(
  opts: SeedCaseOptions = {},
): Promise<SeedCaseResult> {
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
      workingDaysOverdue: opts.workingDaysOverdue ?? 7,
      lastSyncedAt: new Date(),
    },
  });
  const contactSpec = opts.contact ?? {
    primaryEmail: 'jane.tenant@example.com',
    firstName: 'Jane',
  };
  const contact = await prisma.contact.create({
    data: {
      id: contactSpec.id ?? 'contact-pipeline-001',
      organisationId: ORG,
      firstName: contactSpec.firstName ?? null,
      primaryEmail: contactSpec.primaryEmail.toLowerCase(),
      emailsJson: [],
      phonesJson: [],
      lastSyncedAt: new Date(),
    },
  });
  await prisma.tenancyContact.create({
    data: { tenancyId, contactId: contact.id, role: 'TENANT' },
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
  return { caseId: c.id, tenancyId, contactId: contact.id };
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

function makePipeline(
  anthropic: AnthropicClient,
  redactor: Redactor = new DefaultRedactor(),
): InboundPipelineService {
  const s8 = new S8EvaluationService(prisma as unknown as PrismaService);
  const breathingSpace = new BreathingSpaceService(prisma as unknown as PrismaService, s8);
  return new InboundPipelineService(
    prisma as unknown as PrismaService,
    new Clock(),
    new PreFilterService(),
    anthropic,
    redactor,
    breathingSpace,
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

describe('InboundPipelineService — R7.1.b breathing-space auto-activation', () => {
  it('inbound-breathing-space.eml flips Case.breathingSpaceActive and emits BREATHING_SPACE_ACTIVATED', async () => {
    const seed = await seedActiveCaseWithChaseEntries();
    const eml = loadFixture('inbound-breathing-space.eml');
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: eml.subject,
      bodyText: eml.bodyText,
      fromAddress: eml.fromAddress,
    });
    const anthropic = makeAnthropicSpy();
    const pipeline = makePipeline(anthropic.client);

    await pipeline.handle(commId);

    const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: seed.caseId } });
    expect(caseRow.breathingSpaceActive).toBe(true);

    // BREATHING_SPACE_ACTIVATED event with source TENANT_EMAIL_MENTION
    const activated = await prisma.caseEvent.findFirstOrThrow({
      where: { caseId: seed.caseId, kind: 'BREATHING_SPACE_ACTIVATED' },
    });
    const payload = activated.payloadJson as { source: string };
    expect(payload.source).toBe('TENANT_EMAIL_MENTION');

    // No duplicate BREATHING_SPACE flag — the hard-trigger handler raised one,
    // activate() reused it instead of creating a second.
    const flags = await prisma.escalationFlag.findMany({
      where: { caseId: seed.caseId, kind: 'BREATHING_SPACE' },
    });
    expect(flags).toHaveLength(1);

    // Still zero LLM calls.
    expect(anthropic.classify).not.toHaveBeenCalled();
    expect(anthropic.draftReply).not.toHaveBeenCalled();
  });
});

describe('InboundPipelineService — routine fixtures classify + draft', () => {
  for (const fixture of ROUTINE_FIXTURES) {
    it(`${fixture} classifies, drafts a Sonnet reply, queues for approval`, async () => {
      const seed = await seedActiveCaseWithChaseEntries();
      const eml = loadFixture(fixture);
      const commId = await seedInboundCommunication({
        caseId: seed.caseId,
        subject: eml.subject,
        bodyText: eml.bodyText,
        fromAddress: eml.fromAddress,
      });
      const anthropic = makeAnthropicHappyPath();
      const pipeline = makePipeline(anthropic.client);

      const outcome = await pipeline.handle(commId);
      expect(outcome.status).toBe('DRAFTED');
      let draftCommunicationId = '';
      if (outcome.status === 'DRAFTED') {
        draftCommunicationId = outcome.draftCommunicationId;
      }

      expect(anthropic.classify).toHaveBeenCalledOnce();
      expect(anthropic.draftReply).toHaveBeenCalledOnce();

      // ClassificationResult persisted on the inbound communication.
      const cr = await prisma.classificationResult.findUniqueOrThrow({
        where: { communicationId: commId },
      });
      expect(cr.preFilterMatched).toBe(false);
      expect(cr.modelUsed).toBe('claude-haiku-4-5');
      expect(cr.sentiment).toBe('NEUTRAL');
      expect(cr.intent).toBe('PAYMENT_PROMISE');
      expect(cr.confidence?.toNumber()).toBeCloseTo(0.82, 2);
      expect(cr.estimatedCostPence).toBe(1);

      // OUTBOUND draft communication.
      const draft = await prisma.communication.findUniqueOrThrow({
        where: { id: draftCommunicationId },
      });
      expect(draft.direction).toBe('OUTBOUND');
      expect(draft.status).toBe('AWAITING_APPROVAL');
      expect(draft.draftedByAi).toBe(true);
      expect(draft.recipientRole).toBe('TENANT');
      expect(draft.toAddress).toBe(eml.fromAddress);
      expect(draft.bodyMarkdown).toContain('Best regards');
      expect(draft.subject).toBeTruthy();
      // draftSnapshotJson is required by the existing R9 check in
      // ReviewQueueService.approve — make sure it's populated.
      const snap = draft.draftSnapshotJson as Record<string, unknown> | null;
      expect(snap).not.toBeNull();
      expect((snap as { balancePence: string }).balancePence).toBe('200000');

      // OUTBOUND_DRAFT_APPROVAL review item linked to the OUTBOUND draft.
      const rqi = await prisma.reviewQueueItem.findFirstOrThrow({
        where: { caseId: seed.caseId, kind: 'OUTBOUND_DRAFT_APPROVAL' },
      });
      expect(rqi.priority).toBe('NORMAL');
      expect(rqi.communicationId).toBe(draftCommunicationId);
      expect(rqi.classificationResultId).toBe(cr.id);

      // Two timeline events: CLASSIFICATION_PRODUCED + COMMUNICATION_DRAFTED.
      expect(
        await prisma.caseEvent.count({
          where: { caseId: seed.caseId, kind: 'CLASSIFICATION_PRODUCED' },
        }),
      ).toBe(1);
      const draftedEvent = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId: seed.caseId, kind: 'COMMUNICATION_DRAFTED' },
      });
      const draftedPayload = draftedEvent.payloadJson as Record<string, unknown>;
      expect(draftedPayload.inboundCommunicationId).toBe(commId);
      expect(draftedPayload.draftCommunicationId).toBe(draftCommunicationId);
      expect(draftedPayload.draftedByAi).toBe(true);

      // INBOUND communication flipped to PROCESSED; no flags / chase halt.
      const inbound = await prisma.communication.findUniqueOrThrow({
        where: { id: commId },
      });
      expect(inbound.status).toBe('PROCESSED');
      expect(await prisma.escalationFlag.count({ where: { case: { organisationId: ORG } } })).toBe(0);
      const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: seed.caseId } });
      expect(caseRow.awaitingHandlerAction).toBe(false);
      const pendingEntries = await prisma.chaseScheduleEntry.findMany({
        where: { caseId: seed.caseId, firedAt: null },
      });
      expect(pendingEntries).toHaveLength(2);
    });
  }

  it('shapes the classify input from Case + Contact + CaseEvent timeline', async () => {
    const seed = await seedActiveCaseWithChaseEntries({
      contact: {
        primaryEmail: 'jane.tenant@example.com',
        firstName: 'Jane',
      },
      workingDaysOverdue: 11,
    });
    // CHARGE_PARTIALLY_PAID in last 30 days → recentPaymentInLast30Days=true
    await prisma.caseEvent.create({
      data: {
        caseId: seed.caseId,
        kind: 'CHARGE_PARTIALLY_PAID',
        payloadJson: {},
        occurredAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      },
    });
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: 'Re: rent reminder',
      bodyText: 'I will pay the outstanding amount on Friday once my salary clears.',
      fromAddress: 'Jane.Tenant@Example.com',
    });
    const anthropic = makeAnthropicHappyPath();
    const pipeline = makePipeline(anthropic.client);

    await pipeline.handle(commId);

    const arg = anthropic.classify.mock.calls[0]![0];
    expect(arg.organisationId).toBe(ORG);
    expect(arg.caseId).toBe(seed.caseId);
    expect(arg.senderFirstName).toBe('Jane');
    expect(arg.caseContext.balancePounds).toBe(2000); // 200000p / 100
    expect(arg.caseContext.chargeCount).toBe(1);
    expect(arg.caseContext.maxWorkingDaysOverdue).toBe(11);
    expect(arg.caseContext.recentPaymentInLast30Days).toBe(true);
  });

  it('falls back to "the tenant" when the sender has no Contact match', async () => {
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: 'Question',
      bodyText: 'Hi there, quick question about my charges thanks.',
      fromAddress: 'unknown@example.com',
    });
    const anthropic = makeAnthropicHappyPath();
    const pipeline = makePipeline(anthropic.client);

    await pipeline.handle(commId);

    const arg = anthropic.classify.mock.calls[0]![0];
    expect(arg.senderFirstName).toBe('the tenant');
  });

  it('redacts PII out of the body before sending to classify', async () => {
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: 'Contact details',
      bodyText:
        'My new number is 07777 123456 and email is alt@example.com. Postcode SW1A 1AA.',
      fromAddress: 'jane.tenant@example.com',
    });
    const anthropic = makeAnthropicHappyPath();
    const pipeline = makePipeline(anthropic.client);

    await pipeline.handle(commId);

    const arg = anthropic.classify.mock.calls[0]![0];
    expect(arg.redactedBody).toContain('[phone]');
    expect(arg.redactedBody).toContain('[email]');
    expect(arg.redactedBody).toContain('[postcode]');
    expect(arg.redactedBody).not.toContain('07777');
    expect(arg.redactedBody).not.toContain('alt@example.com');
    expect(arg.redactedBody).not.toContain('SW1A');
  });
});

describe('InboundPipelineService — classify failures route to low-confidence queue', () => {
  async function assertLowConfidence(
    seed: SeedCaseResult,
    commId: string,
    opts: { expectFlag: boolean; expectClassificationRow: boolean },
  ): Promise<void> {
    if (opts.expectClassificationRow) {
      expect(
        await prisma.classificationResult.count({ where: { case: { organisationId: ORG } } }),
      ).toBe(1);
    } else {
      expect(
        await prisma.classificationResult.count({ where: { case: { organisationId: ORG } } }),
      ).toBe(0);
    }
    const rqi = await prisma.reviewQueueItem.findFirstOrThrow({
      where: { caseId: seed.caseId },
    });
    expect(rqi.kind).toBe('INBOUND_LOW_CONFIDENCE');
    expect(rqi.priority).toBe('HIGH');
    expect(rqi.communicationId).toBe(commId);
    const flagCount = await prisma.escalationFlag.count({
      where: { caseId: seed.caseId, kind: 'AI_CONFIDENCE_FAILURE' },
    });
    expect(flagCount).toBe(opts.expectFlag ? 1 : 0);
    const inbound = await prisma.communication.findUniqueOrThrow({
      where: { id: commId },
    });
    expect(inbound.status).toBe('PROCESSED');
    // No OUTBOUND draft created.
    expect(
      await prisma.communication.count({
        where: { caseId: seed.caseId, direction: 'OUTBOUND' },
      }),
    ).toBe(0);
    // Chase entries NOT halted — only the hard-trigger flow halts.
    const pending = await prisma.chaseScheduleEntry.findMany({
      where: { caseId: seed.caseId, firedAt: null },
    });
    expect(pending).toHaveLength(2);
  }

  function expectLowConfidence(
    outcome: { status: string },
    reason: LowConfidenceReason,
  ): void {
    expect(outcome.status).toBe('LOW_CONFIDENCE_QUEUED');
    if (outcome.status === 'LOW_CONFIDENCE_QUEUED') {
      expect(
        (outcome as { status: 'LOW_CONFIDENCE_QUEUED'; reason: LowConfidenceReason }).reason,
      ).toBe(reason);
    }
  }

  it('AnthropicSpendCapExceeded routes to low-confidence with the flag raised', async () => {
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: 'Hi',
      bodyText: 'Hi there, will pay later.',
      fromAddress: 'jane.tenant@example.com',
    });
    const anthropic = makeFailingClassifier(
      new AnthropicSpendCapExceeded('over cap', 600, 500),
    );
    const pipeline = makePipeline(anthropic.client);

    expectLowConfidence(await pipeline.handle(commId), 'SPEND_CAP_EXCEEDED');
    expect(anthropic.classify).toHaveBeenCalledOnce();
    expect(anthropic.draftReply).not.toHaveBeenCalled();
    await assertLowConfidence(seed, commId, { expectFlag: true, expectClassificationRow: false });
  });

  it('AnthropicJsonParseError routes to low-confidence with the flag raised', async () => {
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: 'Hi',
      bodyText: 'Some text.',
      fromAddress: 'jane.tenant@example.com',
    });
    const anthropic = makeFailingClassifier(
      new AnthropicJsonParseError('not json', 'Sorry, I cannot do that.'),
    );
    const pipeline = makePipeline(anthropic.client);

    expectLowConfidence(await pipeline.handle(commId), 'JSON_PARSE_FAILED');
    await assertLowConfidence(seed, commId, { expectFlag: true, expectClassificationRow: false });
  });

  it('RedactionRequiredError from the wrapper routes to low-confidence with the flag raised', async () => {
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: 'Hi',
      bodyText: 'Routine text.',
      fromAddress: 'jane.tenant@example.com',
    });
    const anthropic = makeFailingClassifier(
      new RedactionRequiredError('phone slipped through'),
    );
    const pipeline = makePipeline(anthropic.client);

    expectLowConfidence(await pipeline.handle(commId), 'REDACTION_FAILED');
    await assertLowConfidence(seed, commId, { expectFlag: true, expectClassificationRow: false });
  });

  it('generic SDK error routes to low-confidence as LLM_REQUEST_FAILED with the flag raised', async () => {
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: 'Hi',
      bodyText: 'Routine text.',
      fromAddress: 'jane.tenant@example.com',
    });
    const anthropic = makeFailingClassifier(new Error('network down'));
    const pipeline = makePipeline(anthropic.client);

    expectLowConfidence(await pipeline.handle(commId), 'LLM_REQUEST_FAILED');
    await assertLowConfidence(seed, commId, { expectFlag: true, expectClassificationRow: false });
  });

  it('empty body skips the LLM call entirely and routes to low-confidence with the flag raised', async () => {
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: '(empty)',
      bodyText: '   ',
      fromAddress: 'jane.tenant@example.com',
    });
    const anthropic = makeAnthropicHappyPath();
    const pipeline = makePipeline(anthropic.client);

    expectLowConfidence(await pipeline.handle(commId), 'EMPTY_BODY');
    expect(anthropic.classify).not.toHaveBeenCalled();
    expect(anthropic.draftReply).not.toHaveBeenCalled();
    await assertLowConfidence(seed, commId, { expectFlag: true, expectClassificationRow: false });
  });
});

describe('InboundPipelineService — routing decisions after classification', () => {
  async function setupAndRun(classifyOverride: Partial<AnthropicClassifyResult>): Promise<{
    seed: SeedCaseResult;
    commId: string;
    outcome: Awaited<ReturnType<InboundPipelineService['handle']>>;
    anthropic: ReturnType<typeof makeAnthropicHappyPath>;
  }> {
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: 'Hi',
      bodyText: 'Routine message body for routing tests.',
      fromAddress: 'jane.tenant@example.com',
    });
    const anthropic = makeAnthropicHappyPath({ classify: classifyOverride });
    const pipeline = makePipeline(anthropic.client);
    const outcome = await pipeline.handle(commId);
    return { seed, commId, outcome, anthropic };
  }

  it('COMPLAINT intent routes to low-confidence with the flag raised (no draft)', async () => {
    const { seed, commId, outcome, anthropic } = await setupAndRun({
      intent: 'COMPLAINT',
      confidence: 0.95,
    });

    expect(outcome.status).toBe('LOW_CONFIDENCE_QUEUED');
    if (outcome.status === 'LOW_CONFIDENCE_QUEUED') {
      expect(outcome.reason).toBe('COMPLAINT_INTENT');
    }
    expect(anthropic.draftReply).not.toHaveBeenCalled();
    // ClassificationResult IS persisted on routing-decision low-confidence.
    expect(
      await prisma.classificationResult.count({ where: { case: { organisationId: ORG } } }),
    ).toBe(1);
    const flagCount = await prisma.escalationFlag.count({
      where: { caseId: seed.caseId, kind: 'AI_CONFIDENCE_FAILURE' },
    });
    expect(flagCount).toBe(1);
    const inbound = await prisma.communication.findUniqueOrThrow({ where: { id: commId } });
    expect(inbound.status).toBe('PROCESSED');
  });

  it('UNCLEAR intent routes to low-confidence with the flag raised', async () => {
    const { outcome, anthropic } = await setupAndRun({
      intent: 'UNCLEAR',
      confidence: 0.95,
    });
    expect(outcome.status).toBe('LOW_CONFIDENCE_QUEUED');
    if (outcome.status === 'LOW_CONFIDENCE_QUEUED') {
      expect(outcome.reason).toBe('UNCLEAR_INTENT');
    }
    expect(anthropic.draftReply).not.toHaveBeenCalled();
  });

  it('DISTRESSED sentiment routes to low-confidence — but does NOT raise the flag', async () => {
    const { seed, outcome, anthropic } = await setupAndRun({
      sentiment: 'DISTRESSED',
      intent: 'PAYMENT_PROMISE',
      confidence: 0.95,
    });

    expect(outcome.status).toBe('LOW_CONFIDENCE_QUEUED');
    if (outcome.status === 'LOW_CONFIDENCE_QUEUED') {
      expect(outcome.reason).toBe('DISTRESSED_SENTIMENT');
    }
    expect(anthropic.draftReply).not.toHaveBeenCalled();

    // The review item is queued and the inbound is PROCESSED, but the
    // AI_CONFIDENCE_FAILURE flag is NOT raised — distress is a soft
    // signal per docs/ai-decision-spec.md.
    const rqi = await prisma.reviewQueueItem.findFirstOrThrow({
      where: { caseId: seed.caseId },
    });
    expect(rqi.kind).toBe('INBOUND_LOW_CONFIDENCE');
    expect(
      await prisma.escalationFlag.count({
        where: { caseId: seed.caseId, kind: 'AI_CONFIDENCE_FAILURE' },
      }),
    ).toBe(0);
  });

  it('confidence below the default 0.75 threshold routes to low-confidence', async () => {
    const { outcome, anthropic } = await setupAndRun({
      intent: 'QUERY',
      confidence: 0.6,
    });
    expect(outcome.status).toBe('LOW_CONFIDENCE_QUEUED');
    if (outcome.status === 'LOW_CONFIDENCE_QUEUED') {
      expect(outcome.reason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    }
    expect(anthropic.draftReply).not.toHaveBeenCalled();
  });

  it('respects a custom OrganisationConfig.aiConfidenceThreshold', async () => {
    // Threshold set to 0.5 → 0.6 confidence should now draft.
    await prisma.organisationConfig.create({
      data: {
        organisationId: ORG,
        templateWd3Tenant: 'wd3',
        templateWd5Tenant: 'wd5',
        templateWd8Tenant: 'wd8',
        templateWd14Tenant: 'wd14',
        templateBrokenPromise: 'broken',
        aiConfidenceThreshold: 0.5,
      },
    });
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: 'Hi',
      bodyText: 'Routine.',
      fromAddress: 'jane.tenant@example.com',
    });
    const anthropic = makeAnthropicHappyPath({
      classify: { intent: 'QUERY', confidence: 0.6 },
    });
    const pipeline = makePipeline(anthropic.client);

    const outcome = await pipeline.handle(commId);
    expect(outcome.status).toBe('DRAFTED');
    expect(anthropic.draftReply).toHaveBeenCalledOnce();
  });
});

describe('InboundPipelineService — draft failure falls back to low-confidence', () => {
  it('draftReply throwing routes to LOW_CONFIDENCE_QUEUED with reason DRAFT_FAILED', async () => {
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: 'Hi',
      bodyText: 'Routine.',
      fromAddress: 'jane.tenant@example.com',
    });
    const anthropic = makeFailingDrafter({
      draftError: new AnthropicSpendCapExceeded('cap hit on draft step', 600, 500),
    });
    const pipeline = makePipeline(anthropic.client);

    const outcome = await pipeline.handle(commId);
    expect(outcome.status).toBe('LOW_CONFIDENCE_QUEUED');
    if (outcome.status === 'LOW_CONFIDENCE_QUEUED') {
      expect(outcome.reason).toBe('DRAFT_FAILED');
    }

    // Classification result IS persisted (it succeeded).
    expect(
      await prisma.classificationResult.count({ where: { case: { organisationId: ORG } } }),
    ).toBe(1);

    // OUTBOUND draft NOT created.
    expect(
      await prisma.communication.count({
        where: { caseId: seed.caseId, direction: 'OUTBOUND' },
      }),
    ).toBe(0);

    // Flag is raised on draft failure.
    expect(
      await prisma.escalationFlag.count({
        where: { caseId: seed.caseId, kind: 'AI_CONFIDENCE_FAILURE' },
      }),
    ).toBe(1);

    // INBOUND_LOW_CONFIDENCE review item linked to the inbound.
    const rqi = await prisma.reviewQueueItem.findFirstOrThrow({
      where: { caseId: seed.caseId },
    });
    expect(rqi.kind).toBe('INBOUND_LOW_CONFIDENCE');
    expect(rqi.priority).toBe('HIGH');
    expect(rqi.communicationId).toBe(commId);
  });
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
