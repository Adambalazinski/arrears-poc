import { apiJson, apiFetch } from './api-client';
import type { components } from './openapi';

// Sourced from the generated OpenAPI types. Regenerate after changing the
// backend response shape: `pnpm --filter backend openapi:export &&
// pnpm --filter frontend openapi:generate`.
export type Organisation = components['schemas']['OrganisationResponseDto'];

export interface OrganisationConfig {
  organisationId: string;
  chaseDayFirst: number;
  chaseDaySecond: number;
  chaseDayThird: number;
  chaseDayExecNotify: number;
  workingDayCalendar: string;
  s8RentMonthsThreshold: number;
  s8WeeksThreshold: number;
  pollingIntervalMinutes: number;
  autoSendEnabled: boolean;
  aiClassificationModel: string;
  aiDraftModel: string;
  /** Prisma Decimal serialises as string. */
  aiConfidenceThreshold: string;
  templateWd3Tenant: string;
  templateWd5Tenant: string;
  templateWd8Tenant: string;
  templateWd14Tenant: string;
  templateBrokenPromise: string;
  hardTriggerOverrides: unknown;
}

export interface CredentialSummary {
  organisationId: string;
  storageBackend: 'LOCAL' | 'SECRETS_MANAGER';
  accessTokenMask: string | null;
  refreshTokenMask: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  createdAt: string;
  createdByUserId: string;
  rotatedAt: string | null;
  rotatedByUserId: string | null;
  lastUsedAt: string | null;
}

export interface ProbeUpstreamResult {
  status: 'OK' | 'FAILED' | 'NOT_IMPLEMENTED';
  message: string;
  latencyMs: number;
}

export interface ProbeResult {
  overall: 'OK' | 'PARTIAL' | 'FAILED';
  lwca: ProbeUpstreamResult;
  rentancy: ProbeUpstreamResult;
}

export interface StoreCredentialResult {
  probe: ProbeResult;
  saved: boolean;
  reason?: string;
}

export const listOrganisations = () => apiJson<Organisation[]>('/api/organisations');

export const getOrganisation = (id: string) =>
  apiJson<Organisation>(`/api/organisations/${encodeURIComponent(id)}`);

export const createOrganisation = (input: { id: string; name: string }) =>
  apiJson<Organisation>('/api/organisations', {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'Content-Type': 'application/json' },
  });

export const getOrgConfig = (id: string) =>
  apiJson<OrganisationConfig>(`/api/organisations/${encodeURIComponent(id)}/config`);

export const patchOrgConfig = (id: string, patch: Partial<OrganisationConfig>) =>
  apiJson<OrganisationConfig>(`/api/organisations/${encodeURIComponent(id)}/config`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    headers: { 'Content-Type': 'application/json' },
  });

export const getCredentials = async (id: string): Promise<CredentialSummary | null> => {
  const res = await apiFetch(`/api/organisations/${encodeURIComponent(id)}/credentials`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as CredentialSummary) : null;
};

export const storeCredentials = (
  id: string,
  input: {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
    allowFailedProbe?: boolean;
  },
) =>
  apiJson<StoreCredentialResult>(`/api/organisations/${encodeURIComponent(id)}/credentials`, {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'Content-Type': 'application/json' },
  });

export const probeCredentials = (id: string, accessToken: string) =>
  apiJson<ProbeResult>(`/api/organisations/${encodeURIComponent(id)}/credentials/probe`, {
    method: 'POST',
    body: JSON.stringify({ accessToken }),
    headers: { 'Content-Type': 'application/json' },
  });
