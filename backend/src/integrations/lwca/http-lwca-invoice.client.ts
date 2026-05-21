import { Injectable, Logger } from '@nestjs/common';
import { CognitoService } from '../cognito/cognito.service';
import type {
  LwcaInvoiceClient,
  LwcaProbeOutcome,
} from './lwca-invoice.client';
import { LwcaInvoiceMapper, type MappedLwcaInvoice } from './lwca-invoice.mapper';
import { LwcaPagedInvoicesSchema } from './lwca-invoice.types';
import { normaliseStagePage } from './lwca-stage-shape';

const ARREARS_QS = new URLSearchParams({
  type: 'OUTBOUND',
  isArrear: 'true',
  statuses: 'UNPAID,PARTIALLY_PAID,PARTIALLY_RECONCILED',
  // Arrears chasing is rent-only: we explicitly exclude deposits, council tax,
  // utilities, etc. LWCA exposes the line-item-type vocabulary on
  // GET /v1/api/invoice/lineItemType — "Rent" is one of those literal values.
  lineItemType: 'Rent',
  size: '100',
  sort: 'due_date,asc',
});

const PROBE_QS = new URLSearchParams({ type: 'OUTBOUND', size: '1' });

@Injectable()
export class HttpLwcaInvoiceClient implements LwcaInvoiceClient {
  private readonly logger = new Logger(HttpLwcaInvoiceClient.name);
  private readonly baseUrl: string;

  constructor(private readonly cognito: CognitoService) {
    const url = process.env.LWCA_STAGE_BASE_URL;
    if (!url) throw new Error('LWCA_STAGE_BASE_URL env var is required for HttpLwcaInvoiceClient');
    if (isProductionLikeHost(url)) {
      // Hard rule #1: production must not appear in any code path.
      throw new Error(`LWCA_STAGE_BASE_URL points at a production-like host: ${url}`);
    }
    this.baseUrl = url.replace(/\/+$/, '');
  }

  async listArrears(organisationId: string): Promise<MappedLwcaInvoice[]> {
    return this.cognito.withFreshAccessToken(organisationId, async (token) => {
      // LWCA stage rejects page=0 with "must be greater than or equal to 1",
      // so pages are 1-indexed against the API even though the response's
      // `number` field is the same value.
      let page = 1;
      const all: MappedLwcaInvoice[] = [];
      while (true) {
        const qs = new URLSearchParams(ARREARS_QS);
        qs.set('page', String(page));
        const body = await this.get(qs, token);
        const parsed = LwcaPagedInvoicesSchema.parse(normaliseStagePage(body));
        all.push(...LwcaInvoiceMapper.mapPage(parsed.content));
        const totalPages = parsed.totalPages ?? 1;
        if (page >= totalPages || parsed.content.length === 0) break;
        page += 1;
      }
      return all;
    });
  }

  async probe(_organisationId: string, accessToken: string): Promise<LwcaProbeOutcome> {
    const started = Date.now();
    try {
      const url = `${this.baseUrl}/v1/api/invoice?${PROBE_QS.toString()}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return { ok: false, message: `${res.status} ${res.statusText}`, latencyMs };
      }
      // Stage `/v1/api/invoice` on the frontend host returns 200 HTML for any
      // request — auth header is ignored. Refuse to call that "OK" or admins
      // see a green probe with credentials that won't actually work.
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('json')) {
        return {
          ok: false,
          message: `${res.status} ${res.statusText} — non-JSON response (content-type: ${contentType}); LWCA_STAGE_BASE_URL probably points at the frontend, not the API`,
          latencyMs,
        };
      }
      return { ok: true, message: `${res.status} ${res.statusText}`, latencyMs };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      };
    }
  }

  private async get(qs: URLSearchParams, accessToken: string): Promise<unknown> {
    const url = `${this.baseUrl}/v1/api/invoice?${qs.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LwcaHttpError(res.status, `LWCA GET /invoice -> ${res.status}: ${body}`);
    }
    return res.json();
  }
}

export class LwcaHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'LwcaHttpError';
  }
}

function isProductionLikeHost(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes('.prod.')) return true;
  if (/^https?:\/\/(www\.)?uk\.loftyworks\.com/.test(lower)) return true;
  if (/loftyworks\.com(\/|$)/.test(lower) && !lower.includes('stage')) return true;
  return false;
}
