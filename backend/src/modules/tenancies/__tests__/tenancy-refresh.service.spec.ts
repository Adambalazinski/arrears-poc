import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixtureRentancyClient } from '../../../integrations/rentancy/fixture-rentancy.client';
import {
  RentancyNotFoundError,
  type RentancyTenancyClient,
} from '../../../integrations/rentancy/rentancy.client';
import type { PrismaService } from '../../../integrations/prisma/prisma.service';
import { TenancyRefreshService } from '../tenancy-refresh.service';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';
const RENTANCY_FIXTURE_DIR = '../fixtures/rentancy';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const ORG_ID = 'rentancy-refresh-test';

async function wipeOrg(): Promise<void> {
  await prisma.tenancyContact.deleteMany({
    where: { tenancy: { organisationId: ORG_ID } },
  });
  await prisma.contact.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.organisation.deleteMany({ where: { id: ORG_ID } });
}

beforeAll(async () => {
  await prisma.$connect();
  await wipeOrg();
  await prisma.organisation.create({ data: { id: ORG_ID, name: 'Rentancy refresh test' } });
});

afterAll(async () => {
  await wipeOrg();
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Keep the organisation, wipe everything else.
  await prisma.tenancyContact.deleteMany({
    where: { tenancy: { organisationId: ORG_ID } },
  });
  await prisma.contact.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
});

afterEach(async () => {
  await prisma.tenancyContact.deleteMany({
    where: { tenancy: { organisationId: ORG_ID } },
  });
  await prisma.contact.deleteMany({ where: { organisationId: ORG_ID } });
  await prisma.tenancy.deleteMany({ where: { organisationId: ORG_ID } });
});

function fixtureService(): TenancyRefreshService {
  const client = new FixtureRentancyClient(RENTANCY_FIXTURE_DIR);
  return new TenancyRefreshService(prisma as unknown as PrismaService, client);
}

describe('TenancyRefreshService.refreshFromRentancy', () => {
  it('creates Tenancy + Contacts + TenancyContact rows from Rentancy fixture', async () => {
    const svc = fixtureService();
    const r = await svc.refreshFromRentancy(ORG_ID, 'tenancy-abc-001');
    expect(r.notFound).toBe(false);
    expect(r.contactsRefreshed).toBe(2);

    const tenancy = await prisma.tenancy.findUniqueOrThrow({
      where: { id: 'tenancy-abc-001' },
    });
    expect(tenancy.status).toBe('ACTIVE');
    expect(tenancy.reference).toBe('TN-2024-001');
    expect(tenancy.rentDayOfMonth).toBe(1);
    expect(tenancy.rentAmountPence).toBe(120000n);

    const contacts = await prisma.contact.findMany({
      where: { organisationId: ORG_ID },
      orderBy: { id: 'asc' },
    });
    expect(contacts.map((c) => c.id).sort()).toEqual([
      'contact-guarantor-001',
      'contact-tenant-001',
    ]);

    const links = await prisma.tenancyContact.findMany({
      where: { tenancyId: 'tenancy-abc-001' },
    });
    const linkKeys = links.map((l) => `${l.role}:${l.contactId}`).sort();
    expect(linkKeys).toEqual([
      'GUARANTOR:contact-guarantor-001',
      'TENANT:contact-tenant-001',
    ]);
  });

  it('preserves LWCA-owned property fields when re-running', async () => {
    // Phase 4.3 wrote a stub with property fields. Simulate that here.
    await prisma.tenancy.create({
      data: {
        id: 'tenancy-abc-001',
        organisationId: ORG_ID,
        propertyId: 'prop-001',
        propertyName: 'Flat 2',
        propertyAddress1: '12 High Street',
        propertyAddress2: 'London W1 1AA',
        status: 'UNKNOWN',
        lastSyncedAt: new Date(),
      },
    });

    const svc = fixtureService();
    await svc.refreshFromRentancy(ORG_ID, 'tenancy-abc-001');
    const t = await prisma.tenancy.findUniqueOrThrow({ where: { id: 'tenancy-abc-001' } });
    expect(t.propertyName).toBe('Flat 2');
    expect(t.propertyAddress1).toBe('12 High Street');
    expect(t.propertyAddress2).toBe('London W1 1AA');
    // Rentancy fields overwrite UNKNOWN
    expect(t.status).toBe('ACTIVE');
  });

  it('removes TenancyContact rows for contacts no longer on the tenancy', async () => {
    // Pre-seed a stale guarantor link that's not in the current Rentancy
    // payload. The refresh should remove it.
    const svc = fixtureService();
    await svc.refreshFromRentancy(ORG_ID, 'tenancy-abc-001');

    // Insert a stale link directly so we can prove the next refresh cleans it.
    await prisma.contact.create({
      data: {
        id: 'stale-contact',
        organisationId: ORG_ID,
        firstName: 'Old',
        lastName: 'Guarantor',
        emailsJson: [],
        phonesJson: [],
        lastSyncedAt: new Date(),
      },
    });
    await prisma.tenancyContact.create({
      data: {
        tenancyId: 'tenancy-abc-001',
        contactId: 'stale-contact',
        role: 'GUARANTOR',
      },
    });

    // Re-run refresh: Rentancy doesn't know about stale-contact, so the
    // join row should be removed.
    await svc.refreshFromRentancy(ORG_ID, 'tenancy-abc-001');
    const links = await prisma.tenancyContact.findMany({
      where: { tenancyId: 'tenancy-abc-001' },
    });
    expect(links.map((l) => l.contactId)).not.toContain('stale-contact');
    expect(links.map((l) => l.contactId).sort()).toEqual([
      'contact-guarantor-001',
      'contact-tenant-001',
    ]);
    // The Contact row itself is left alone (it might still be linked elsewhere).
    const contact = await prisma.contact.findUnique({ where: { id: 'stale-contact' } });
    expect(contact).not.toBeNull();
  });

  it('returns notFound=true and does not throw when Rentancy 404s on the tenancy', async () => {
    const failing: RentancyTenancyClient = {
      getTenancy: vi.fn().mockRejectedValue(new RentancyNotFoundError('tenancy', 'gone')),
      getContact: vi.fn(),
      probe: vi.fn().mockResolvedValue({ ok: true, message: 'n/a', latencyMs: 0 }),
    };
    const svc = new TenancyRefreshService(prisma as unknown as PrismaService, failing);
    const r = await svc.refreshFromRentancy(ORG_ID, 'gone');
    expect(r.notFound).toBe(true);
    expect(failing.getContact).not.toHaveBeenCalled();
  });

  it('tolerates a 404 on a single contact and persists the rest', async () => {
    const partial: RentancyTenancyClient = {
      getTenancy: vi.fn().mockResolvedValue({
        tenancyId: 'tenancy-partial',
        propertyId: 'prop-partial',
        status: 'ACTIVE' as const,
        reference: null,
        rentDayOfMonth: null,
        rentAmountPence: null,
        tenantContactIds: ['c-ok', 'c-missing'],
        guarantorContactIds: [],
      }),
      getContact: vi.fn(async (_orgId: string, id: string) => {
        if (id === 'c-missing') throw new RentancyNotFoundError('contact', id);
        return {
          contactId: id,
          firstName: 'Real',
          lastName: 'Tenant',
          companyName: null,
          primaryEmail: 'real@example.com',
          emailsJson: [],
          phonesJson: [],
        };
      }),
      probe: vi.fn().mockResolvedValue({ ok: true, message: 'n/a', latencyMs: 0 }),
    };
    const svc = new TenancyRefreshService(prisma as unknown as PrismaService, partial);
    const r = await svc.refreshFromRentancy(ORG_ID, 'tenancy-partial');
    expect(r.contactsRefreshed).toBe(1);
    expect(r.notFound).toBe(false);
    const contacts = await prisma.contact.findMany({ where: { organisationId: ORG_ID } });
    expect(contacts.map((c) => c.id)).toEqual(['c-ok']);
    // Dangling contact id (Rentancy listed it but the contact 404'd) is
    // dropped — the TenancyContact FK to Contact would reject it anyway.
    const links = await prisma.tenancyContact.findMany({
      where: { tenancyId: 'tenancy-partial' },
    });
    expect(links.map((l) => l.contactId)).toEqual(['c-ok']);
  });
});
