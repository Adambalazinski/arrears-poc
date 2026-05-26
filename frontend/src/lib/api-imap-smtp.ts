import { apiJson } from './api-client';

export interface ImapSmtpStatus {
  connected: boolean;
  mailboxAddress: string | null;
  imapHost: string | null;
  imapPort: number | null;
  smtpHost: string | null;
  smtpPort: number | null;
  connectedAt: string | null;
  connectedByUserId: string | null;
  lastUsedAt: string | null;
}

export interface ImapSmtpConnectInput {
  mailboxAddress: string;
  appPassword: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

export const getImapSmtpStatus = () =>
  apiJson<ImapSmtpStatus>('/api/auth/imap-smtp/status');

export const connectImapSmtp = (input: ImapSmtpConnectInput) =>
  apiJson<ImapSmtpStatus>('/api/auth/imap-smtp/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

export const disconnectImapSmtp = () =>
  apiJson<{ ok: true }>('/api/auth/imap-smtp/disconnect', { method: 'POST' });
