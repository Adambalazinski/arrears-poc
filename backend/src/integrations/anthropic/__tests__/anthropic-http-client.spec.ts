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
import { RedactionRequiredError, type Redactor } from '../../../modules/ai/redactor';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  AnthropicJsonParseError,
  AnthropicSpendCapExceeded,
  type AnthropicClassifyInput,
  type AnthropicDraftInput,
} from '../anthropic-client';
import {
  AnthropicHttpClient,
  type AnthropicSdkLike,
  type AnthropicSdkResponse,
} from '../anthropic-http-client';
import { ModelNotAllowedError } from '../pricing';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const ORG = 'anthropic-http-test-org';
const TENANCY = 'anthropic-http-test-tenancy';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

async function wipe(): Promise<void> {
  await prisma.classificationResult.deleteMany({
    where: { case: { organisationId: ORG } },
  });
  await prisma.case.deleteMany({ where: { organisationId: ORG } });
  await prisma.tenancy.deleteMany({ where: { id: TENANCY } });
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
  await prisma.organisation.create({ data: { id: ORG, name: 'Test Org' } });
});

afterEach(async () => {
  await wipe();
  vi.restoreAllMocks();
});

function makeRedactor(opts: { willThrow?: boolean } = {}): Redactor {
  return {
    redact: (text: string) => ({ text, redactionCount: 0 }),
    assertSafe: () => {
      if (opts.willThrow) {
        throw new RedactionRequiredError('PII pattern still present');
      }
    },
  };
}

function makeSdk(
  response: AnthropicSdkResponse = {
    content: [{ type: 'text', text: '{"sentiment":"NEUTRAL","intent":"QUERY","confidence":0.9,"rationale":"asking a question"}' }],
    usage: { input_tokens: 600, output_tokens: 50 },
    stop_reason: 'end_turn',
  },
): { sdk: AnthropicSdkLike; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => response);
  return {
    sdk: { messages: { create } } as AnthropicSdkLike,
    create,
  };
}

function makeClient(
  sdk: AnthropicSdkLike,
  redactor: Redactor = makeRedactor(),
): AnthropicHttpClient {
  return new AnthropicHttpClient(
    prisma as unknown as PrismaService,
    new Clock(),
    sdk,
    redactor,
  );
}

const CLASSIFY_INPUT: AnthropicClassifyInput = {
  organisationId: ORG,
  caseId: 'case-1',
  redactedBody: 'Could you let me know about the additional fee on last month?',
  senderFirstName: 'Jane',
  caseContext: {
    balancePounds: 2400,
    chargeCount: 3,
    maxWorkingDaysOverdue: 8,
    recentPaymentInLast30Days: false,
  },
};

const DRAFT_INPUT: AnthropicDraftInput = {
  organisationId: ORG,
  caseId: 'case-1',
  redactedBody: 'I will pay on Friday.',
  senderFirstName: 'Jane',
  caseContext: {
    balancePounds: 1200,
    chargeCount: 1,
    maxChargeAmountPounds: 1200,
    maxChargeDueDateFormatted: '1 May 2026',
    maxWorkingDaysOverdue: 5,
  },
  classification: { sentiment: 'NEUTRAL', intent: 'PAYMENT_PROMISE' },
};

describe('AnthropicHttpClient.classify — happy path', () => {
  it('parses valid JSON, computes cost, defaults to haiku', async () => {
    const { sdk, create } = makeSdk();
    const client = makeClient(sdk);
    const result = await client.classify(CLASSIFY_INPUT);

    expect(create).toHaveBeenCalledOnce();
    const params = create.mock.calls[0]![0];
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.max_tokens).toBeGreaterThan(0);
    expect(params.system).toContain('UK lettings agency');
    expect(params.messages[0].content).toContain('Jane');
    expect(params.messages[0].content).toContain('£2,400.00');

    expect(result.modelUsed).toBe('claude-haiku-4-5');
    expect(result.sentiment).toBe('NEUTRAL');
    expect(result.intent).toBe('QUERY');
    expect(result.confidence).toBe(0.9);
    expect(result.rationale).toBe('asking a question');
    expect(result.promptTokens).toBe(600);
    expect(result.completionTokens).toBe(50);
    // 600 tokens * 80p/M + 50 tokens * 400p/M = 0.048 + 0.02 = 0.068p → ceil = 1p
    expect(result.estimatedCostPence).toBe(1);
  });

  it('tolerates a ```json``` fenced response', async () => {
    const { sdk } = makeSdk({
      content: [
        {
          type: 'text',
          text: '```json\n{"sentiment":"POSITIVE","intent":"PAYMENT_CONFIRMATION","confidence":0.85,"rationale":"says paid"}\n```',
        },
      ],
      usage: { input_tokens: 500, output_tokens: 40 },
    });
    const client = makeClient(sdk);
    const result = await client.classify(CLASSIFY_INPUT);
    expect(result.intent).toBe('PAYMENT_CONFIRMATION');
  });
});

describe('AnthropicHttpClient.classify — safety boundary', () => {
  it('redactor.assertSafe throwing aborts the call before the SDK runs', async () => {
    const { sdk, create } = makeSdk();
    const client = makeClient(sdk, makeRedactor({ willThrow: true }));
    await expect(client.classify(CLASSIFY_INPUT)).rejects.toBeInstanceOf(
      RedactionRequiredError,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses when daily spend cap is already reached', async () => {
    // Seed a case and a classification_result row whose cost already
    // meets ANTHROPIC_SPEND_CAP_GBP_DAILY (default £5 = 500p).
    await prisma.tenancy.create({
      data: {
        id: TENANCY,
        organisationId: ORG,
        propertyId: 'p',
        status: 'ACTIVE',
        lastSyncedAt: new Date(),
      },
    });
    const c = await prisma.case.create({
      data: {
        organisationId: ORG,
        tenancyId: TENANCY,
        status: 'ACTIVE',
        openedAt: new Date(),
        lastKnownBalancePence: 0n,
        lastKnownBalanceAt: new Date(),
      },
    });
    await prisma.classificationResult.create({
      data: {
        caseId: c.id,
        communicationId: 'comm-historic',
        preFilterMatched: false,
        modelUsed: 'claude-haiku-4-5',
        estimatedCostPence: 500,
        createdAt: new Date(),
      },
    });
    // Need a Communication row for the FK? communicationId is @unique on
    // ClassificationResult but the relation is via communicationId only
    // — there's no Prisma relation on communication here, so the row is
    // fine without a backing Communication.

    const { sdk, create } = makeSdk();
    const client = makeClient(sdk);
    await expect(client.classify(CLASSIFY_INPUT)).rejects.toBeInstanceOf(
      AnthropicSpendCapExceeded,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses unknown models without touching the SDK', async () => {
    const { sdk, create } = makeSdk();
    const client = makeClient(sdk);
    await expect(
      client.classify({ ...CLASSIFY_INPUT, modelId: 'claude-mystery-9' }),
    ).rejects.toBeInstanceOf(ModelNotAllowedError);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('AnthropicHttpClient.classify — JSON robustness', () => {
  it('non-JSON response raises AnthropicJsonParseError with raw text', async () => {
    const { sdk } = makeSdk({
      content: [{ type: 'text', text: 'Sorry, I cannot do that.' }],
      usage: { input_tokens: 500, output_tokens: 10 },
    });
    const client = makeClient(sdk);
    await expect(client.classify(CLASSIFY_INPUT)).rejects.toMatchObject({
      name: 'AnthropicJsonParseError',
      rawOutput: 'Sorry, I cannot do that.',
    });
  });

  it('JSON missing a required field raises AnthropicJsonParseError', async () => {
    const { sdk } = makeSdk({
      content: [
        {
          type: 'text',
          text: '{"sentiment":"NEUTRAL","intent":"QUERY","confidence":0.9}',
        },
      ],
      usage: { input_tokens: 500, output_tokens: 20 },
    });
    const client = makeClient(sdk);
    await expect(client.classify(CLASSIFY_INPUT)).rejects.toBeInstanceOf(
      AnthropicJsonParseError,
    );
  });

  it('confidence outside 0..1 raises AnthropicJsonParseError', async () => {
    const { sdk } = makeSdk({
      content: [
        {
          type: 'text',
          text: '{"sentiment":"NEUTRAL","intent":"QUERY","confidence":1.5,"rationale":"x"}',
        },
      ],
      usage: { input_tokens: 500, output_tokens: 20 },
    });
    const client = makeClient(sdk);
    await expect(client.classify(CLASSIFY_INPUT)).rejects.toBeInstanceOf(
      AnthropicJsonParseError,
    );
  });
});

describe('AnthropicHttpClient.draftReply', () => {
  it('happy path: returns trimmed body and computes Sonnet cost', async () => {
    const { sdk, create } = makeSdk({
      content: [{ type: 'text', text: '\nDear Jane,\n\nThanks for the message...\n\n' }],
      usage: { input_tokens: 800, output_tokens: 200 },
    });
    const client = makeClient(sdk);
    const result = await client.draftReply(DRAFT_INPUT);

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0].model).toBe('claude-sonnet-4-6');
    expect(result.bodyMarkdown.startsWith('Dear Jane,')).toBe(true);
    expect(result.bodyMarkdown.endsWith('message...')).toBe(true);
    expect(result.promptTokens).toBe(800);
    expect(result.completionTokens).toBe(200);
    expect(result.estimatedCostPence).toBe(1);
  });

  it('empty content raises AnthropicEmptyContentError', async () => {
    const { sdk } = makeSdk({
      content: [{ type: 'text', text: '' }],
      usage: { input_tokens: 800, output_tokens: 0 },
      stop_reason: 'max_tokens',
    });
    const client = makeClient(sdk);
    await expect(client.draftReply(DRAFT_INPUT)).rejects.toMatchObject({
      name: 'AnthropicEmptyContentError',
    });
  });

  it('respects modelId override when in the allowlist', async () => {
    const { sdk, create } = makeSdk();
    const client = makeClient(sdk);
    await client.draftReply({ ...DRAFT_INPUT, modelId: 'claude-haiku-4-5' });
    expect(create.mock.calls[0]![0].model).toBe('claude-haiku-4-5');
  });
});
