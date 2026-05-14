import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RentancyMapper } from '../rentancy.mapper';
import { RentancyContactSchema, RentancyTenancySchema } from '../rentancy.types';

const FIXTURES = path.resolve(__dirname, '../../../../../fixtures/rentancy');

async function load<T extends 'tenancies' | 'contacts'>(kind: T, id: string): Promise<unknown> {
  const raw = await fs.readFile(path.join(FIXTURES, kind, `${id}.json`), 'utf-8');
  return JSON.parse(raw);
}

describe('RentancyMapper.tenancy (fixture)', () => {
  it('maps a tenancy with guarantor + tenant', async () => {
    const t = RentancyTenancySchema.parse(await load('tenancies', 'tenancy-abc-001'));
    const out = RentancyMapper.tenancy(t);
    expect(out.tenancyId).toBe('tenancy-abc-001');
    expect(out.propertyId).toBe('prop-001');
    expect(out.status).toBe('ACTIVE');
    expect(out.reference).toBe('TN-2024-001');
    expect(out.rentDayOfMonth).toBe(1);
    expect(out.rentAmountPence).toBe(120000n);
    expect(out.tenantContactIds).toEqual(['contact-tenant-001']);
    expect(out.guarantorContactIds).toEqual(['contact-guarantor-001']);
  });

  it('handles tenancies with no guarantors', async () => {
    const t = RentancyTenancySchema.parse(await load('tenancies', 'tenancy-xyz-002'));
    const out = RentancyMapper.tenancy(t);
    expect(out.guarantorContactIds).toEqual([]);
  });

  it('prefers guarantorIds over the legacy guarantors field and dedupes', () => {
    const t = RentancyTenancySchema.parse({
      id: 't',
      tenancyPropertyId: 'p',
      status: 'ACTIVE',
      tenants: ['a'],
      guarantorIds: ['g1', 'g1', 'g2'],
      guarantors: ['SHOULD-BE-IGNORED'],
    });
    expect(RentancyMapper.tenancy(t).guarantorContactIds).toEqual(['g1', 'g2']);
  });

  it('falls back to `guarantors` when `guarantorIds` is absent', () => {
    const t = RentancyTenancySchema.parse({
      id: 't',
      tenancyPropertyId: 'p',
      status: 'ACTIVE',
      tenants: [],
      guarantors: ['g3'],
    });
    expect(RentancyMapper.tenancy(t).guarantorContactIds).toEqual(['g3']);
  });

  it('maps unknown statuses to UNKNOWN', () => {
    const t = RentancyTenancySchema.parse({
      id: 't',
      tenancyPropertyId: 'p',
      status: 'PENDING',
      tenants: [],
    });
    expect(RentancyMapper.tenancy(t).status).toBe('UNKNOWN');
  });
});

describe('RentancyMapper.contact (fixture)', () => {
  it('maps tenant fields and picks the first email as primary', async () => {
    const c = RentancyContactSchema.parse(await load('contacts', 'contact-tenant-001'));
    const out = RentancyMapper.contact(c);
    expect(out.contactId).toBe('contact-tenant-001');
    expect(out.firstName).toBe('Jane');
    expect(out.lastName).toBe('Tenant');
    expect(out.primaryEmail).toBe('jane.tenant@example.com');
    expect(out.emailsJson).toHaveLength(2);
    expect(out.phonesJson).toEqual([{ type: 'MOBILE', phone: '+447700900000' }]);
  });

  it('handles a contact with no emails', () => {
    const c = RentancyContactSchema.parse({
      id: 'x',
      fname: 'X',
      sname: 'Y',
      emails: [],
      phones: [],
    });
    expect(RentancyMapper.contact(c).primaryEmail).toBeNull();
  });
});
