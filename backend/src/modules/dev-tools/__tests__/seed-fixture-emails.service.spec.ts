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
import { PreFilterService } from '../../ai/pre-filter.service';
import { DefaultRedactor } from '../../ai/redactor';
import { BreathingSpaceService } from '../../cases/breathing-space.service';
import { S8EvaluationService } from '../../cases/s8-evaluation.service';
import { InboundPipelineService } from '../../inbound/inbound-pipeline.service';
import { SeedFixtureEmailsService } from '../seed-fixture-emails.service';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const ORG = 'seed-fixture-test-org';
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
  await prisma.organisation.create({ data: { id: ORG, name: 'Seed test org' } });
  await prisma.tenancy.create({
    data: {
      id: 'tn-1',
      organisationId: ORG,
      propertyId: 'p',
      status: 'ACTIVE',
      lastSyncedAt: new Date(),
    },
  });
  await prisma.contact.create({
    data: {
      id: 'contact-tenant',
      organisationId: ORG,
      primaryEmail: 'demo.tenant@example.com',
      firstName: 'Demo',
      emailsJson: [],
      phonesJson: [],
      lastSyncedAt: new Date(),
    },
  });
  await prisma.tenancyContact.create({
    data: { tenancyId: 'tn-1', contactId: 'contact-tenant', role: 'TENANT' },
  });
});

afterEach(async () => {
  await wipe();
  vi.restoreAllMocks();
});

async function seedActiveCase(): Promise<string> {
  const c = await prisma.case.create({
    data: {
      organisationId: ORG,
      tenancyId: 'tn-1',
      status: 'ACTIVE',
      openedAt: new Date('2026-05-01T00:00:00Z'),
      lastKnownBalancePence: 150000n,
      lastKnownBalanceAt: new Date(),
    },
  });
  return c.id;
}

function makeHappyAnthropic(): {
  client: AnthropicClient;
  classify: ReturnType<typeof vi.fn>;
  draftReply: ReturnType<typeof vi.fn>;
} {
  const classify = vi.fn(async () => ({
    modelUsed: 'claude-haiku-4-5',
    sentiment: 'NEUTRAL',
    intent: 'PAYMENT_PROMISE',
    confidence: 0.85,
    rationale: 'tenant will pay',
    promptTokens: 500,
    completionTokens: 30,
    estimatedCostPence: 1,
  }));
  const draftReply = vi.fn(async () => ({
    modelUsed: 'claude-sonnet-4-6',
    bodyMarkdown: 'Dear Demo,\n\nThanks for the update.',
    promptTokens: 800,
    completionTokens: 100,
    estimatedCostPence: 1,
  }));
  return {
    client: { classify, draftReply } as unknown as AnthropicClient,
    classify,
    draftReply,
  };
}

function makeService(anthropic: AnthropicClient): SeedFixtureEmailsService {
  const s8 = new S8EvaluationService(prisma as unknown as PrismaService);
  const breathingSpace = new BreathingSpaceService(prisma as unknown as PrismaService, s8);
  const pipeline = new InboundPipelineService(
    prisma as unknown as PrismaService,
    new Clock(),
    new PreFilterService(),
    anthropic,
    new DefaultRedactor(),
    breathingSpace,
  );
  return new SeedFixtureEmailsService(
    prisma as unknown as PrismaService,
    new Clock(),
    pipeline,
  );
}

describe('SeedFixtureEmailsService.listFixtures', () => {
  it('returns the nine .eml fixtures', () => {
    const fixtures = makeService(makeHappyAnthropic().client).listFixtures();
    expect(fixtures.length).toBe(9);
    expect(fixtures).toContain('inbound-routine-promise.eml');
    expect(fixtures).toContain('inbound-hardship.eml');
  });
});

describe('SeedFixtureEmailsService.seedOne', () => {
  it('persists an inbound Communication and runs the pipeline through to DRAFTED on a routine fixture', async () => {
    const caseId = await seedActiveCase();
    const anthropic = makeHappyAnthropic();
    const svc = makeService(anthropic.client);

    const result = await svc.seedOne(caseId, 'inbound-routine-promise.eml');

    expect(result.outcome.status).toBe('DRAFTED');
    expect(anthropic.classify).toHaveBeenCalledOnce();
    expect(anthropic.draftReply).toHaveBeenCalledOnce();

    const comm = await prisma.communication.findUniqueOrThrow({
      where: { id: result.communicationId },
    });
    expect(comm.direction).toBe('INBOUND');
    // The case has a tenant contact; from-address was rewritten to that
    // contact's primaryEmail so the classifier prompt gets a real name.
    expect(comm.fromAddress).toBe('demo.tenant@example.com');
    const classifyArg = anthropic.classify.mock.calls[0]![0];
    expect(classifyArg.senderFirstName).toBe('Demo');
  });

  it('takes the HARD_TRIGGER path on a hardship fixture without calling Anthropic', async () => {
    const caseId = await seedActiveCase();
    const anthropic = makeHappyAnthropic();
    const svc = makeService(anthropic.client);

    const result = await svc.seedOne(caseId, 'inbound-hardship.eml');
    expect(result.outcome.status).toBe('HARD_TRIGGER');
    if (result.outcome.status === 'HARD_TRIGGER') {
      expect(result.outcome.trigger).toBe('HARDSHIP_INDICATED');
    }
    expect(anthropic.classify).not.toHaveBeenCalled();
    expect(anthropic.draftReply).not.toHaveBeenCalled();

    const urgent = await prisma.reviewQueueItem.findFirstOrThrow({
      where: { caseId, kind: 'HARD_TRIGGER_ESCALATION' },
    });
    expect(urgent.priority).toBe('URGENT');
    expect(urgent.classificationResultId).not.toBeNull();
  });

  it('rejects unknown fixture names', async () => {
    const caseId = await seedActiveCase();
    const svc = makeService(makeHappyAnthropic().client);
    await expect(svc.seedOne(caseId, 'inbound-does-not-exist.eml')).rejects.toThrow();
  });

  it('rejects unknown case ids', async () => {
    const svc = makeService(makeHappyAnthropic().client);
    await expect(
      svc.seedOne('00000000-0000-0000-0000-000000000000', 'inbound-routine-promise.eml'),
    ).rejects.toThrow(/not found/);
  });
});

describe('SeedFixtureEmailsService.seedAll', () => {
  it('drops every fixture onto the case and returns nine outcomes', async () => {
    const caseId = await seedActiveCase();
    const svc = makeService(makeHappyAnthropic().client);
    const results = await svc.seedAll(caseId);
    expect(results.length).toBe(9);

    const counts = await prisma.communication.count({
      where: { caseId, direction: 'INBOUND' },
    });
    expect(counts).toBe(9);

    // Six hard-trigger fixtures + three routine ones — six should be
    // HARD_TRIGGER, three DRAFTED.
    const drafted = results.filter((r) => r.outcome.status === 'DRAFTED').length;
    const hardTrigger = results.filter((r) => r.outcome.status === 'HARD_TRIGGER').length;
    expect(hardTrigger).toBe(6);
    expect(drafted).toBe(3);
  });
});
