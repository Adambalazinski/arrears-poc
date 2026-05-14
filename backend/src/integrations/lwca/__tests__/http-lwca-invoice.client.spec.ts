import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpLwcaInvoiceClient } from '../http-lwca-invoice.client';
import type { CognitoService } from '../../cognito/cognito.service';

const ORIG = process.env.LWCA_STAGE_BASE_URL;

beforeEach(() => {
  process.env.LWCA_STAGE_BASE_URL = 'https://stage.uk.loftyworks.com';
});

afterEach(() => {
  if (ORIG) process.env.LWCA_STAGE_BASE_URL = ORIG;
  else delete process.env.LWCA_STAGE_BASE_URL;
  vi.restoreAllMocks();
});

function passthroughCognito(): CognitoService {
  return {
    withFreshAccessToken: async (_org: string, fn: (t: string) => Promise<unknown>) =>
      fn('stage-access-token'),
  } as unknown as CognitoService;
}

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(handler));
}

describe('HttpLwcaInvoiceClient', () => {
  it('refuses to instantiate against a production-like base URL', () => {
    process.env.LWCA_STAGE_BASE_URL = 'https://uk.loftyworks.com';
    expect(() => new HttpLwcaInvoiceClient(passthroughCognito())).toThrow(
      /production-like host/,
    );
  });

  it('listArrears: calls /v1/api/invoice with the arrears filter + bearer token', async () => {
    const calls: string[] = [];
    mockFetch(async (url, init) => {
      calls.push(url);
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer stage-access-token',
      );
      return new Response(
        JSON.stringify({
          content: [
            {
              id: 'inv-1',
              organisationId: 'org-1',
              grossAmount: 100,
              remainAmount: 100,
              dueDate: '2026-04-01',
              invoiceDate: '2026-03-15',
              status: 'UNPAID',
              paymentCycleType: 'MONTHLY',
              tenancyId: 't-1',
              property: { propertyId: 'p-1' },
            },
          ],
          totalPages: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new HttpLwcaInvoiceClient(passthroughCognito());
    const out = await client.listArrears('org-1');
    expect(out).toHaveLength(1);
    expect(out[0]!.charge.lwcaInvoiceId).toBe('inv-1');
    expect(calls[0]).toContain('/v1/api/invoice?');
    expect(calls[0]).toContain('isArrear=true');
    expect(calls[0]).toContain('statuses=UNPAID%2CPARTIALLY_PAID%2CPARTIALLY_RECONCILED');
    expect(calls[0]).toContain('type=INBOUND');
  });

  it('listArrears: paginates until totalPages is exhausted', async () => {
    const pages = [
      [
        {
          id: 'inv-a',
          organisationId: 'org-1',
          grossAmount: 100,
          remainAmount: 100,
          dueDate: '2026-04-01',
          invoiceDate: '2026-03-15',
          status: 'UNPAID',
          paymentCycleType: 'MONTHLY',
          tenancyId: 't-1',
        },
      ],
      [
        {
          id: 'inv-b',
          organisationId: 'org-1',
          grossAmount: 100,
          remainAmount: 100,
          dueDate: '2026-04-08',
          invoiceDate: '2026-03-22',
          status: 'UNPAID',
          paymentCycleType: 'MONTHLY',
          tenancyId: 't-1',
        },
      ],
    ];
    let page = 0;
    mockFetch(async () => {
      const body = JSON.stringify({ content: pages[page]!, totalPages: 2 });
      page++;
      return new Response(body, { status: 200 });
    });

    const client = new HttpLwcaInvoiceClient(passthroughCognito());
    const out = await client.listArrears('org-1');
    expect(out.map((m) => m.charge.lwcaInvoiceId)).toEqual(['inv-a', 'inv-b']);
  });

  it('probe: ok=true on 200, ok=false on 401', async () => {
    let nextStatus = 200;
    mockFetch(async () =>
      nextStatus === 200
        ? new Response('{"content":[]}', { status: 200 })
        : new Response('{"error":"unauth"}', { status: 401, statusText: 'Unauthorized' }),
    );

    const client = new HttpLwcaInvoiceClient(passthroughCognito());
    const ok = await client.probe('org-1', 'tok');
    expect(ok.ok).toBe(true);
    nextStatus = 401;
    const bad = await client.probe('org-1', 'tok');
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('401');
  });

  it('probe: ok=false on network failure', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const client = new HttpLwcaInvoiceClient(passthroughCognito());
    const out = await client.probe('org-1', 'tok');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('fetch failed');
  });
});
