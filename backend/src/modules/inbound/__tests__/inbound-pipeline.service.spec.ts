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
} from '../../../integrations/anthropic/anthropic-client';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';
import type { HardTriggerKind } from '../../ai/hard-triggers';
import { PreFilterService } from '../../ai/pre-filter.service';
import { DefaultRedactor, RedactionRequiredError, type Redactor } from '../../ai/redactor';
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

function makeHappyClassifier(
  overrides: Partial<AnthropicClassifyResult> = {},
): {
  client: AnthropicClient;
  classify: ReturnType<typeof vi.fn>;
  draftReply: ReturnType<typeof vi.fn>;
} {
  const result: AnthropicClassifyResult = {
    modelUsed: 'claude-haiku-4-5',
    sentiment: 'NEUTRAL',
    intent: 'PAYMENT_PROMISE',
    confidence: 0.82,
    rationale: 'tenant offers to pay on Friday',
    promptTokens: 540,
    completionTokens: 35,
    estimatedCostPence: 1,
    ...overrides,
  };
  const classify = vi.fn(async () => result);
  const draftReply = vi.fn(async () => {
    throw new Error('draftReply must not be called in Phase 7.6 tests');
  });
  return {
    client: { classify, draftReply } as unknown as AnthropicClient,
    classify,
    draftReply,
  };
}

function makeFailingClassifier(err: Error): {
  client: AnthropicClient;
  classify: ReturnType<typeof vi.fn>;
} {
  const classify = vi.fn(async () => {
    throw err;
  });
  return {
    client: { classify, draftReply: vi.fn() } as unknown as AnthropicClient,
    classify,
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
  return new InboundPipelineService(
    prisma as unknown as PrismaService,
    new Clock(),
    new PreFilterService(),
    anthropic,
    redactor,
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

describe('InboundPipelineService — routine fixtures classify successfully', () => {
  for (const fixture of ROUTINE_FIXTURES) {
    it(`${fixture} calls classify, persists ClassificationResult, emits CLASSIFICATION_PRODUCED`, async () => {
      const seed = await seedActiveCaseWithChaseEntries();
      const eml = loadFixture(fixture);
      const commId = await seedInboundCommunication({
        caseId: seed.caseId,
        subject: eml.subject,
        bodyText: eml.bodyText,
        fromAddress: eml.fromAddress,
      });
      const anthropic = makeHappyClassifier();
      const pipeline = makePipeline(anthropic.client);

      const outcome = await pipeline.handle(commId);
      expect(outcome.status).toBe('CLASSIFIED');

      expect(anthropic.classify).toHaveBeenCalledOnce();
      expect(anthropic.draftReply).not.toHaveBeenCalled();

      const cr = await prisma.classificationResult.findUniqueOrThrow({
        where: { communicationId: commId },
      });
      expect(cr.preFilterMatched).toBe(false);
      expect(cr.modelUsed).toBe('claude-haiku-4-5');
      expect(cr.sentiment).toBe('NEUTRAL');
      expect(cr.intent).toBe('PAYMENT_PROMISE');
      expect(cr.confidence?.toNumber()).toBeCloseTo(0.82, 2);
      expect(cr.rationale).toBe('tenant offers to pay on Friday');
      expect(cr.promptTokens).toBe(540);
      expect(cr.completionTokens).toBe(35);
      expect(cr.estimatedCostPence).toBe(1);

      const event = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId: seed.caseId, kind: 'CLASSIFICATION_PRODUCED' },
      });
      const payload = event.payloadJson as Record<string, unknown>;
      expect(payload.communicationId).toBe(commId);
      expect(payload.sentiment).toBe('NEUTRAL');
      expect(payload.intent).toBe('PAYMENT_PROMISE');

      // No escalation side-effects on a successful classify.
      expect(await prisma.escalationFlag.count()).toBe(0);
      expect(await prisma.reviewQueueItem.count()).toBe(0);
      const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: seed.caseId } });
      expect(caseRow.awaitingHandlerAction).toBe(false);
      const pendingEntries = await prisma.chaseScheduleEntry.findMany({
        where: { caseId: seed.caseId, firedAt: null },
      });
      expect(pendingEntries).toHaveLength(2);

      // Communication stays RECEIVED — Phase 7.7 will route + flip.
      const comm = await prisma.communication.findUniqueOrThrow({
        where: { id: commId },
      });
      expect(comm.status).toBe('RECEIVED');
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
    const anthropic = makeHappyClassifier();
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
    const anthropic = makeHappyClassifier();
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
    const anthropic = makeHappyClassifier();
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

describe('InboundPipelineService — classify failure modes', () => {
  async function assertLowConfidenceSideEffects(
    seed: SeedCaseResult,
    commId: string,
  ): Promise<void> {
    // No success row persisted.
    expect(await prisma.classificationResult.count()).toBe(0);
    // INBOUND_LOW_CONFIDENCE review item at HIGH priority.
    const rqi = await prisma.reviewQueueItem.findFirstOrThrow({
      where: { caseId: seed.caseId },
    });
    expect(rqi.kind).toBe('INBOUND_LOW_CONFIDENCE');
    expect(rqi.priority).toBe('HIGH');
    expect(rqi.communicationId).toBe(commId);
    // AI_CONFIDENCE_FAILURE flag.
    const flag = await prisma.escalationFlag.findFirstOrThrow({
      where: { caseId: seed.caseId, kind: 'AI_CONFIDENCE_FAILURE' },
    });
    expect(flag.resolvedAt).toBeNull();
    // ESCALATION_FLAG_RAISED event.
    expect(
      await prisma.caseEvent.count({
        where: { caseId: seed.caseId, kind: 'ESCALATION_FLAG_RAISED' },
      }),
    ).toBe(1);
    // Communication → PROCESSED.
    const comm = await prisma.communication.findUniqueOrThrow({
      where: { id: commId },
    });
    expect(comm.status).toBe('PROCESSED');
    // Chase entries NOT halted — only the hard-trigger flow halts.
    const pending = await prisma.chaseScheduleEntry.findMany({
      where: { caseId: seed.caseId, firedAt: null },
    });
    expect(pending).toHaveLength(2);
  }

  it('AnthropicSpendCapExceeded routes to low-confidence queue', async () => {
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

    const outcome = await pipeline.handle(commId);
    expect(outcome.status).toBe('CLASSIFY_FAILED');
    if (outcome.status === 'CLASSIFY_FAILED') {
      expect(outcome.reason).toBe('SPEND_CAP_EXCEEDED');
    }
    expect(anthropic.classify).toHaveBeenCalledOnce();
    await assertLowConfidenceSideEffects(seed, commId);
  });

  it('AnthropicJsonParseError routes to low-confidence queue', async () => {
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

    const outcome = await pipeline.handle(commId);
    expect(outcome.status).toBe('CLASSIFY_FAILED');
    if (outcome.status === 'CLASSIFY_FAILED') {
      expect(outcome.reason).toBe('JSON_PARSE_FAILED');
    }
    await assertLowConfidenceSideEffects(seed, commId);
  });

  it('RedactionRequiredError thrown by Redactor inside the wrapper routes to low-confidence queue', async () => {
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

    const outcome = await pipeline.handle(commId);
    expect(outcome.status).toBe('CLASSIFY_FAILED');
    if (outcome.status === 'CLASSIFY_FAILED') {
      expect(outcome.reason).toBe('REDACTION_FAILED');
    }
    await assertLowConfidenceSideEffects(seed, commId);
  });

  it('generic SDK error routes to low-confidence queue as LLM_REQUEST_FAILED', async () => {
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: 'Hi',
      bodyText: 'Routine text.',
      fromAddress: 'jane.tenant@example.com',
    });
    const anthropic = makeFailingClassifier(new Error('network down'));
    const pipeline = makePipeline(anthropic.client);

    const outcome = await pipeline.handle(commId);
    expect(outcome.status).toBe('CLASSIFY_FAILED');
    if (outcome.status === 'CLASSIFY_FAILED') {
      expect(outcome.reason).toBe('LLM_REQUEST_FAILED');
    }
    await assertLowConfidenceSideEffects(seed, commId);
  });

  it('empty body skips the LLM call and routes to low-confidence queue', async () => {
    const seed = await seedActiveCaseWithChaseEntries();
    const commId = await seedInboundCommunication({
      caseId: seed.caseId,
      subject: '(empty)',
      bodyText: '   ',
      fromAddress: 'jane.tenant@example.com',
    });
    const anthropic = makeHappyClassifier();
    const pipeline = makePipeline(anthropic.client);

    const outcome = await pipeline.handle(commId);
    expect(outcome.status).toBe('CLASSIFY_FAILED');
    if (outcome.status === 'CLASSIFY_FAILED') {
      expect(outcome.reason).toBe('EMPTY_BODY');
    }
    expect(anthropic.classify).not.toHaveBeenCalled();
    await assertLowConfidenceSideEffects(seed, commId);
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
