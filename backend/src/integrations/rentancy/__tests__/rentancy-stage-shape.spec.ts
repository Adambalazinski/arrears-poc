import { describe, expect, it } from 'vitest';
import { RentancyContactSchema, RentancyTenancySchema } from '../rentancy.types';
import { normaliseStageContact, normaliseStageTenancy } from '../rentancy-stage-shape';

describe('normaliseStageTenancy', () => {
  it('extracts tenantId from each tenant object', () => {
    const stage = {
      id: 't1',
      tenancyPropertyId: 'p1',
      status: 'ACTIVE',
      tenants: [
        { tenantId: 'c-aaa', primary: true },
        { tenantId: 'c-bbb', primary: false },
      ],
    };
    const out = normaliseStageTenancy(stage) as Record<string, unknown>;
    expect(out.tenants).toEqual(['c-aaa', 'c-bbb']);
  });

  it('also handles `id`, `guarantorId`, `contactId` candidate keys', () => {
    const stage = {
      id: 't1',
      tenancyPropertyId: 'p1',
      status: 'ACTIVE',
      tenants: [{ id: 'c-id' }, { contactId: 'c-contact' }],
      guarantorIds: [{ guarantorId: 'g-1' }],
    };
    const out = normaliseStageTenancy(stage) as Record<string, unknown>;
    expect(out.tenants).toEqual(['c-id', 'c-contact']);
    expect(out.guarantorIds).toEqual(['g-1']);
  });

  it('passes plain string arrays through unchanged (fixture path)', () => {
    const fixture = {
      id: 't1',
      tenancyPropertyId: 'p1',
      status: 'ACTIVE',
      tenants: ['c-tenant'],
      guarantorIds: ['c-guarantor'],
    };
    const out = normaliseStageTenancy(fixture) as Record<string, unknown>;
    expect(out.tenants).toEqual(['c-tenant']);
    expect(out.guarantorIds).toEqual(['c-guarantor']);
  });

  it('drops malformed array entries instead of throwing', () => {
    const stage = {
      id: 't1',
      tenancyPropertyId: 'p1',
      status: 'ACTIVE',
      tenants: [{ tenantId: 'c-aaa' }, null, { somethingElse: 42 }, 'c-string'],
    };
    const out = normaliseStageTenancy(stage) as Record<string, unknown>;
    expect(out.tenants).toEqual(['c-aaa', 'c-string']);
  });

  it('produces a body that the canonical Zod schema parses', () => {
    const stage = {
      id: 't1',
      tenancyPropertyId: 'p1',
      status: 'ACTIVE',
      tenants: [{ tenantId: 'c-aaa', primary: true }],
      guarantorIds: [{ guarantorId: 'g-1' }],
    };
    const parsed = RentancyTenancySchema.parse(normaliseStageTenancy(stage));
    expect(parsed.tenants).toEqual(['c-aaa']);
    expect(parsed.guarantorIds).toEqual(['g-1']);
  });

  it('lifts stage `rent` into canonical `agreedPrice`', () => {
    const stage = {
      id: 't1',
      tenancyPropertyId: 'p1',
      status: 'ACTIVE',
      rent: 120000,
    };
    const out = normaliseStageTenancy(stage) as Record<string, unknown>;
    expect(out.agreedPrice).toBe(120000);
  });

  it('does not overwrite an existing agreedPrice', () => {
    const fixture = {
      id: 't1',
      tenancyPropertyId: 'p1',
      status: 'ACTIVE',
      agreedPrice: 99999,
      rent: 11111,
    };
    const out = normaliseStageTenancy(fixture) as Record<string, unknown>;
    expect(out.agreedPrice).toBe(99999);
  });
});

describe('normaliseStageContact', () => {
  it('remaps firstName/lastName to fname/sname when fname is missing', () => {
    const stage = {
      id: 'c-1',
      firstName: 'Adam',
      lastName: 'Tenant',
      emails: [{ type: 'PERSONAL', email: 'a@example.com' }],
      phones: [],
    };
    const out = normaliseStageContact(stage) as Record<string, unknown>;
    expect(out.fname).toBe('Adam');
    expect(out.sname).toBe('Tenant');
  });

  it('does not overwrite an existing fname/sname (fixture path)', () => {
    const fixture = {
      id: 'c-1',
      fname: 'Adam',
      sname: 'Tenant',
      firstName: 'SHOULD-BE-IGNORED',
      lastName: 'SHOULD-BE-IGNORED',
      emails: [],
      phones: [],
    };
    const out = normaliseStageContact(fixture) as Record<string, unknown>;
    expect(out.fname).toBe('Adam');
    expect(out.sname).toBe('Tenant');
  });

  it('produces a body that the canonical Zod schema parses', () => {
    const stage = {
      id: 'c-1',
      firstName: 'Adam',
      lastName: 'Tenant',
      emails: [{ type: 'PERSONAL', email: 'a@example.com' }],
      phones: [],
    };
    const parsed = RentancyContactSchema.parse(normaliseStageContact(stage));
    expect(parsed.fname).toBe('Adam');
    expect(parsed.sname).toBe('Tenant');
  });
});
