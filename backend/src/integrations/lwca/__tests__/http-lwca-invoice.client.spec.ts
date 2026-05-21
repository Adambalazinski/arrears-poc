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

/** True for the list endpoint, false for /v1/api/invoice/{id} hydration calls. */
function isListCall(url: string): boolean {
  return /\/v1\/api\/invoice\?/.test(url);
}

describe('HttpLwcaInvoiceClient', () => {
  it('refuses to instantiate against a production-like base URL', () => {
    process.env.LWCA_STAGE_BASE_URL = 'https://uk.loftyworks.com';
    expect(() => new HttpLwcaInvoiceClient(passthroughCognito())).toThrow(
      /production-like host/,
    );
  });

  it('listArrears: calls /v1/api/invoice with the arrears filter + bearer token, then hydrates lineItems per invoice', async () => {
    const calls: string[] = [];
    const summary = {
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
    };
    mockFetch(async (url, init) => {
      calls.push(url);
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer stage-access-token',
      );
      const body = isListCall(url)
        ? { content: [summary], totalPages: 1 }
        : { ...summary, lineItems: [{ type: 'Rent' }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new HttpLwcaInvoiceClient(passthroughCognito());
    const out = await client.listArrears('org-1');
    expect(out).toHaveLength(1);
    expect(out[0]!.charge.lwcaInvoiceId).toBe('inv-1');
    expect(calls[0]).toContain('/v1/api/invoice?');
    expect(calls[0]).toContain('isArrear=true');
    expect(calls[0]).toContain('statuses=UNPAID%2CPARTIALLY_PAID%2CPARTIALLY_RECONCILED');
    expect(calls[0]).toContain('type=OUTBOUND');
    expect(calls[0]).toContain('lineItemType=Rent');
    expect(calls[0]).toContain('page=1');
    expect(calls[1]).toContain('/v1/api/invoice/inv-1');
  });

  it('listArrears: paginates until totalPages is exhausted', async () => {
    const summaries = [
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
    ];
    let page = 0;
    mockFetch(async (url) => {
      if (isListCall(url)) {
        const body = JSON.stringify({ content: [summaries[page]!], totalPages: 2 });
        page++;
        return new Response(body, { status: 200 });
      }
      const id = url.split('/').pop()!.split('?')[0]!;
      const summary = summaries.find((s) => s.id === id)!;
      return new Response(
        JSON.stringify({ ...summary, lineItems: [{ type: 'Rent' }] }),
        { status: 200 },
      );
    });

    const client = new HttpLwcaInvoiceClient(passthroughCognito());
    const out = await client.listArrears('org-1');
    expect(out.map((m) => m.charge.lwcaInvoiceId)).toEqual(['inv-a', 'inv-b']);
  });

  it('rent-only smoke: list returns mixed types, only Rent invoices survive the full pipeline', async () => {
    // Mirrors the production failure mode that motivated the rent-only
    // filter: LWCA's list endpoint returns invoices WITHOUT lineItems, and
    // its single-invoice endpoint returns lineItems WITHOUT description.
    // The client must (a) hit the list, (b) hydrate each via per-invoice
    // fetch, (c) merge so description survives, (d) drop non-Rent.
    //
    // Run with: pnpm --filter backend exec vitest run -t "rent-only smoke"
    const summaries: Record<string, unknown> = {
      'inv-rent': {
        id: 'inv-rent',
        organisationId: 'org-1',
        grossAmount: 100000,
        remainAmount: 100000,
        dueDate: '2026-04-01',
        invoiceDate: '2026-03-15',
        status: 'UNPAID',
        paymentCycleType: 'MONTHLY',
        tenancyId: 't-rent',
        description: 'Rent 04/2026',
      },
      'inv-deposit': {
        id: 'inv-deposit',
        organisationId: 'org-1',
        grossAmount: 50000,
        remainAmount: 50000,
        dueDate: '2026-04-01',
        invoiceDate: '2026-03-15',
        status: 'UNPAID',
        paymentCycleType: 'SINGLE',
        tenancyId: 't-rent',
        description: 'Security deposit',
      },
      'inv-mixed': {
        id: 'inv-mixed',
        organisationId: 'org-1',
        grossAmount: 150000,
        remainAmount: 150000,
        dueDate: '2026-05-01',
        invoiceDate: '2026-04-15',
        status: 'UNPAID',
        paymentCycleType: 'MONTHLY',
        tenancyId: 't-mixed',
        description: 'Rent + council tax 05/2026',
      },
    };
    const lineItemsByInvoice: Record<string, Array<{ type: string }>> = {
      'inv-rent': [{ type: 'Rent' }],
      'inv-deposit': [{ type: 'Security Deposit' }],
      'inv-mixed': [{ type: 'Council Tax' }, { type: 'Rent' }],
    };

    mockFetch(async (url) => {
      if (isListCall(url)) {
        return new Response(
          JSON.stringify({ content: Object.values(summaries), totalPages: 1 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const id = url.split('/').pop()!.split('?')[0]!;
      const summary = summaries[id]!;
      // Single-invoice response shape: lineItems present, description
      // dropped — exactly what stage does.
      const { description: _, ...rest } = summary as { description?: string };
      return new Response(
        JSON.stringify({ ...rest, lineItems: lineItemsByInvoice[id] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new HttpLwcaInvoiceClient(passthroughCognito());
    const out = await client.listArrears('org-1');

    const survivors = out.map((m) => m.charge.lwcaInvoiceId).sort();
    expect(survivors).toEqual(['inv-mixed', 'inv-rent']);
    // Deposit must not appear under any circumstance.
    expect(survivors).not.toContain('inv-deposit');
    // Descriptions must survive the merge — they come from the list call,
    // not the single-invoice fetch.
    const rent = out.find((m) => m.charge.lwcaInvoiceId === 'inv-rent')!;
    expect(rent.charge.lastKnownDescription).toBe('Rent 04/2026');
    const mixed = out.find((m) => m.charge.lwcaInvoiceId === 'inv-mixed')!;
    expect(mixed.charge.lastKnownDescription).toBe('Rent + council tax 05/2026');
  });

  it('probe: ok=true on 200 + JSON content-type, ok=false on 401', async () => {
    let nextStatus = 200;
    mockFetch(async () =>
      nextStatus === 200
        ? new Response('{"content":[]}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
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

  it('probe: ok=false when stage returns 200 + HTML (frontend SPA host)', async () => {
    mockFetch(async () =>
      new Response('<!doctype html><html>...</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    const client = new HttpLwcaInvoiceClient(passthroughCognito());
    const out = await client.probe('org-1', 'tok');
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/non-JSON/);
    expect(out.message).toMatch(/text\/html/);
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
