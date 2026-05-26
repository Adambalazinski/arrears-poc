import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';
import { InboundSenderMatcher } from '../inbound-sender-matcher.service';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';

const ORG_A = 'inbound-test-org-a';
const ORG_B = 'inbound-test-org-b';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

async function wipe(): Promise<void> {
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
});

function makeMatcher(): InboundSenderMatcher {
  return new InboundSenderMatcher(prisma as unknown as PrismaService);
}

describe('InboundSenderMatcher.normaliseEmail', () => {
  it('lowercases and trims', () => {
    expect(InboundSenderMatcher.normaliseEmail('  Jane.Tenant@Example.COM ')).toBe(
      'jane.tenant@example.com',
    );
  });

  it('strips plus-addressing in the local part only', () => {
    expect(InboundSenderMatcher.normaliseEmail('jane+work@example.com')).toBe(
      'jane@example.com',
    );
    expect(InboundSenderMatcher.normaliseEmail('jane@example+plus.com')).toBe(
      'jane@example+plus.com',
    );
  });

  it('returns the raw lowercased value for input without an @', () => {
    expect(InboundSenderMatcher.normaliseEmail('not-an-email')).toBe('not-an-email');
  });
});

describe('InboundSenderMatcher.match', () => {
  it('returns UNMATCHED when no contact matches', async () => {
    const m = await makeMatcher().match('stranger@example.com');
    expect(m.kind).toBe('UNMATCHED');
    if (m.kind === 'UNMATCHED') expect(m.normalisedEmail).toBe('stranger@example.com');
  });

  it('returns UNMATCHED for malformed sender', async () => {
    const m = await makeMatcher().match('not-an-email');
    expect(m.kind).toBe('UNMATCHED');
  });

  it('returns MATCHED on a single primary-email hit', async () => {
    await prisma.contact.create({
      data: {
        id: 'contact-a-1',
        organisationId: ORG_A,
        primaryEmail: 'jane@example.com',
        normalisedPrimaryEmail: 'jane@example.com',
        emailsJson: [],
        phonesJson: [],
        lastSyncedAt: new Date(),
      },
    });
    const m = await makeMatcher().match('Jane@Example.com');
    expect(m.kind).toBe('MATCHED');
    if (m.kind === 'MATCHED') {
      expect(m.contactId).toBe('contact-a-1');
      expect(m.organisationId).toBe(ORG_A);
    }
  });

  it('returns AMBIGUOUS when the same primary email exists across organisations', async () => {
    await prisma.contact.create({
      data: {
        id: 'contact-a-2',
        organisationId: ORG_A,
        primaryEmail: 'shared@example.com',
        normalisedPrimaryEmail: 'shared@example.com',
        emailsJson: [],
        phonesJson: [],
        lastSyncedAt: new Date(),
      },
    });
    await prisma.contact.create({
      data: {
        id: 'contact-b-2',
        organisationId: ORG_B,
        primaryEmail: 'shared@example.com',
        normalisedPrimaryEmail: 'shared@example.com',
        emailsJson: [],
        phonesJson: [],
        lastSyncedAt: new Date(),
      },
    });
    const m = await makeMatcher().match('shared@example.com');
    expect(m.kind).toBe('AMBIGUOUS');
    if (m.kind === 'AMBIGUOUS') {
      expect(m.contacts.map((c) => c.organisationId).sort()).toEqual([ORG_A, ORG_B]);
    }
  });

  it('matches after stripping plus-addressing', async () => {
    await prisma.contact.create({
      data: {
        id: 'contact-a-3',
        organisationId: ORG_A,
        primaryEmail: 'jane@example.com',
        normalisedPrimaryEmail: 'jane@example.com',
        emailsJson: [],
        phonesJson: [],
        lastSyncedAt: new Date(),
      },
    });
    const m = await makeMatcher().match('jane+arrears@example.com');
    expect(m.kind).toBe('MATCHED');
  });
});

describe('InboundSenderMatcher.findActiveCaseForContact', () => {
  async function seedCaseForContact(opts: {
    contactId: string;
    organisationId: string;
    tenancyId: string;
    caseStatus: 'ACTIVE' | 'CLOSED';
    closedAt?: Date;
  }): Promise<string> {
    await prisma.tenancy.create({
      data: {
        id: opts.tenancyId,
        organisationId: opts.organisationId,
        propertyId: 'p',
        status: 'ACTIVE',
        lastSyncedAt: new Date(),
      },
    });
    await prisma.contact.upsert({
      where: { id: opts.contactId },
      create: {
        id: opts.contactId,
        organisationId: opts.organisationId,
        primaryEmail: `${opts.contactId}@example.com`,
        emailsJson: [],
        phonesJson: [],
        lastSyncedAt: new Date(),
      },
      update: {},
    });
    await prisma.tenancyContact.create({
      data: {
        tenancyId: opts.tenancyId,
        contactId: opts.contactId,
        role: 'TENANT',
      },
    });
    const c = await prisma.case.create({
      data: {
        organisationId: opts.organisationId,
        tenancyId: opts.tenancyId,
        status: opts.caseStatus,
        openedAt: new Date('2026-01-01T00:00:00Z'),
        closedAt: opts.closedAt ?? null,
        lastKnownBalancePence: 0n,
        lastKnownBalanceAt: new Date(),
      },
    });
    return c.id;
  }

  it('returns the active case when the contact is on a tenancy with one', async () => {
    const caseId = await seedCaseForContact({
      contactId: 'c-active',
      organisationId: ORG_A,
      tenancyId: 'tn-active',
      caseStatus: 'ACTIVE',
    });
    const result = await makeMatcher().findActiveCaseForContact('c-active', ORG_A);
    expect(result?.caseId).toBe(caseId);
  });

  it('returns null when the contact has only closed cases', async () => {
    await seedCaseForContact({
      contactId: 'c-closed',
      organisationId: ORG_A,
      tenancyId: 'tn-closed',
      caseStatus: 'CLOSED',
      closedAt: new Date(),
    });
    const result = await makeMatcher().findActiveCaseForContact('c-closed', ORG_A);
    expect(result).toBeNull();
  });

  it('most-recent-closed picks the latest closedAt', async () => {
    await prisma.tenancy.create({
      data: {
        id: 'tn-multi',
        organisationId: ORG_A,
        propertyId: 'p',
        status: 'ACTIVE',
        lastSyncedAt: new Date(),
      },
    });
    await prisma.contact.create({
      data: {
        id: 'c-multi',
        organisationId: ORG_A,
        primaryEmail: 'multi@example.com',
        emailsJson: [],
        phonesJson: [],
        lastSyncedAt: new Date(),
      },
    });
    await prisma.tenancyContact.create({
      data: { tenancyId: 'tn-multi', contactId: 'c-multi', role: 'TENANT' },
    });
    await prisma.case.create({
      data: {
        organisationId: ORG_A,
        tenancyId: 'tn-multi',
        status: 'CLOSED',
        openedAt: new Date('2025-01-01T00:00:00Z'),
        closedAt: new Date('2025-03-01T00:00:00Z'),
        lastKnownBalancePence: 0n,
        lastKnownBalanceAt: new Date(),
      },
    });
    const newer = await prisma.case.create({
      data: {
        organisationId: ORG_A,
        tenancyId: 'tn-multi',
        status: 'CLOSED',
        openedAt: new Date('2025-04-01T00:00:00Z'),
        closedAt: new Date('2025-06-01T00:00:00Z'),
        lastKnownBalancePence: 0n,
        lastKnownBalanceAt: new Date(),
      },
    });
    const result = await makeMatcher().findMostRecentClosedCaseForContact(
      'c-multi',
      ORG_A,
    );
    expect(result?.caseId).toBe(newer.id);
  });
});
