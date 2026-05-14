import { Injectable, Logger } from '@nestjs/common';
import { CognitoService } from '../cognito/cognito.service';
import {
  RentancyNotFoundError,
  type RentancyProbeOutcome,
  type RentancyTenancyClient,
} from './rentancy.client';
import { RentancyMapper, type RentancyContactUpsert, type RentancyTenancyUpsert } from './rentancy.mapper';
import { RentancyContactSchema, RentancyTenancySchema } from './rentancy.types';

@Injectable()
export class HttpRentancyClient implements RentancyTenancyClient {
  private readonly logger = new Logger(HttpRentancyClient.name);
  private readonly baseUrl: string;

  constructor(private readonly cognito: CognitoService) {
    const url = process.env.RENTANCY_STAGE_BASE_URL;
    if (!url) throw new Error('RENTANCY_STAGE_BASE_URL env var is required for HttpRentancyClient');
    if (isProductionLikeHost(url)) {
      throw new Error(`RENTANCY_STAGE_BASE_URL points at a production-like host: ${url}`);
    }
    this.baseUrl = url.replace(/\/+$/, '');
  }

  getTenancy(orgId: string, tenancyId: string): Promise<RentancyTenancyUpsert> {
    return this.cognito.withFreshAccessToken(orgId, async (token) => {
      const body = await this.get(
        `/v2/organisations/${encodeURIComponent(orgId)}/tenancies/${encodeURIComponent(tenancyId)}`,
        token,
        { notFoundKind: 'tenancy', notFoundId: tenancyId },
      );
      return RentancyMapper.tenancy(RentancyTenancySchema.parse(body));
    });
  }

  getContact(orgId: string, contactId: string): Promise<RentancyContactUpsert> {
    return this.cognito.withFreshAccessToken(orgId, async (token) => {
      const body = await this.get(
        `/v2/organisations/${encodeURIComponent(orgId)}/contacts/${encodeURIComponent(contactId)}`,
        token,
        { notFoundKind: 'contact', notFoundId: contactId },
      );
      return RentancyMapper.contact(RentancyContactSchema.parse(body));
    });
  }

  async probe(organisationId: string, accessToken: string): Promise<RentancyProbeOutcome> {
    const started = Date.now();
    try {
      const url = `${this.baseUrl}/v2/organisations/${encodeURIComponent(
        organisationId,
      )}/tenancies?limit=1`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return { ok: false, message: `${res.status} ${res.statusText}`, latencyMs };
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('json')) {
        return {
          ok: false,
          message: `${res.status} ${res.statusText} — non-JSON response (content-type: ${contentType}); RENTANCY_STAGE_BASE_URL probably points at the wrong host`,
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

  private async get(
    pathSuffix: string,
    accessToken: string,
    { notFoundKind, notFoundId }: { notFoundKind: 'tenancy' | 'contact'; notFoundId: string },
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${pathSuffix}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (res.status === 404) throw new RentancyNotFoundError(notFoundKind, notFoundId);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new RentancyHttpError(res.status, `Rentancy GET ${pathSuffix} -> ${res.status}: ${body}`);
    }
    return res.json();
  }
}

export class RentancyHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'RentancyHttpError';
  }
}

function isProductionLikeHost(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes('.prod.')) return true;
  if (/loftyworks\.com(\/|$)/.test(lower) && !lower.includes('stage')) return true;
  return false;
}
