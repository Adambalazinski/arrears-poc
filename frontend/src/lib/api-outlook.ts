import { apiJson } from './api-client';

export interface OutlookOAuthStatus {
  connected: boolean;
  mailboxUpn: string | null;
  tenantId: string | null;
  connectedAt: string | null;
  connectedByUserId: string | null;
  lastRefreshedAt: string | null;
}

export const getOutlookStatus = () =>
  apiJson<OutlookOAuthStatus>('/api/auth/outlook/status');

export const initiateOutlookConnect = (mailboxUpn: string) =>
  apiJson<{ authorizeUrl: string }>(
    `/api/auth/outlook/initiate?mailboxUpn=${encodeURIComponent(mailboxUpn)}`,
  );

export const disconnectOutlook = () =>
  apiJson<{ ok: true }>('/api/auth/outlook/disconnect', { method: 'POST' });
