import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitoService } from '../../cognito/cognito.service';
import { HttpRentancyClient } from '../http-rentancy.client';
import { RentancyNotFoundError } from '../rentancy.client';

const ORIG = process.env.RENTANCY_STAGE_BASE_URL;

beforeEach(() => {
  process.env.RENTANCY_STAGE_BASE_URL = 'https://api.stage.uk.loftyworks.com';
});

afterEach(() => {
  if (ORIG) process.env.RENTANCY_STAGE_BASE_URL = ORIG;
  else delete process.env.RENTANCY_STAGE_BASE_URL;
  vi.restoreAllMocks();
});

function passthroughCognito(): CognitoService {
  return {
    withFreshAccessToken: async (_org: string, fn: (t: string) => Promise<unknown>) =>
      fn('stage-token'),
  } as unknown as CognitoService;
}

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(handler));
}

describe('HttpRentancyClient', () => {
  it('refuses production-like base URLs', () => {
    process.env.RENTANCY_STAGE_BASE_URL = 'https://api.uk.loftyworks.com';
    expect(() => new HttpRentancyClient(passthroughCognito())).toThrow(/production-like host/);
  });

  it('getTenancy: hits the right path with bearer and maps the response', async () => {
    let seen = '';
    mockFetch(async (url, init) => {
      seen = url;
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer stage-token');
      return new Response(
        JSON.stringify({
          id: 't-1',
          tenancyPropertyId: 'p-1',
          status: 'ACTIVE',
          tenants: ['c-1'],
          guarantorIds: [],
          paymentDay: 5,
          agreedPrice: 95000,
        }),
        { status: 200 },
      );
    });

    const client = new HttpRentancyClient(passthroughCognito());
    const out = await client.getTenancy('org-1', 't-1');
    expect(seen).toBe('https://api.stage.uk.loftyworks.com/v2/organisations/org-1/tenancies/t-1');
    expect(out.tenancyId).toBe('t-1');
    expect(out.tenantContactIds).toEqual(['c-1']);
    expect(out.rentAmountPence).toBe(95000n);
  });

  it('getTenancy: 404 -> RentancyNotFoundError(tenancy, id)', async () => {
    mockFetch(async () => new Response('{}', { status: 404 }));
    const client = new HttpRentancyClient(passthroughCognito());
    await expect(client.getTenancy('org-1', 'missing')).rejects.toBeInstanceOf(
      RentancyNotFoundError,
    );
  });

  it('getContact: maps emails and primary email', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          id: 'c-1',
          fname: 'Jane',
          sname: 'T',
          emails: [{ type: 'PERSONAL', email: 'a@x.com' }],
        }),
        { status: 200 },
      ),
    );
    const client = new HttpRentancyClient(passthroughCognito());
    const out = await client.getContact('org-1', 'c-1');
    expect(out.primaryEmail).toBe('a@x.com');
  });

  it('probe: 200 -> ok; non-2xx -> not ok', async () => {
    let status = 200;
    mockFetch(async () => new Response('{}', { status, statusText: status === 200 ? 'OK' : 'X' }));
    const client = new HttpRentancyClient(passthroughCognito());
    const ok = await client.probe('org-1', 'tok');
    expect(ok.ok).toBe(true);
    status = 403;
    const denied = await client.probe('org-1', 'tok');
    expect(denied.ok).toBe(false);
    expect(denied.message).toContain('403');
  });
});
