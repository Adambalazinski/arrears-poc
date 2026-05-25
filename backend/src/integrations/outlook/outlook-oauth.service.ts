import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { decrypt, encrypt, loadKeyFromEnv } from '../credential-store/credential-crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Delegated-OAuth state for the app's single shared Outlook mailbox.
 *
 * The user clicks "Connect Outlook" → backend mints an auth URL with
 * `offline_access` in the scope → user consents at login.microsoftonline.com
 * → Microsoft redirects back to /auth/outlook/callback with a code →
 * backend exchanges code+secret for {access_token, refresh_token} → we
 * store the refresh token encrypted on the singleton OutlookOAuthConnection.
 *
 * After that, every Graph call goes through getValidAccessToken() which
 * either returns the cached access token (if it has >= 60 seconds left)
 * or burns the refresh token for a fresh one. Microsoft returns a new
 * refresh token on every refresh ("rolling"), so we always overwrite.
 */
const SINGLETON_ID = 'default';
const TOKEN_ENDPOINT = (tenantId: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
const AUTHORIZE_ENDPOINT = (tenantId: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`;
// 60s safety buffer: refresh when the current access token has < 60s left.
const ACCESS_TOKEN_SKEW_MS = 60_000;

export interface OutlookOAuthStatus {
  connected: boolean;
  mailboxUpn: string | null;
  tenantId: string | null;
  connectedAt: string | null;
  connectedByUserId: string | null;
  lastRefreshedAt: string | null;
}

export interface TokenExchangeResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
  scope: string;
}

@Injectable()
export class OutlookOAuthService {
  private readonly logger = new Logger(OutlookOAuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Build the OAuth authorize URL the user redirects to in the browser. */
  buildAuthorizeUrl(opts: {
    tenantId: string;
    clientId: string;
    redirectUri: string;
    state: string;
  }): string {
    const qs = new URLSearchParams({
      client_id: opts.clientId,
      response_type: 'code',
      redirect_uri: opts.redirectUri,
      response_mode: 'query',
      // `offline_access` is what makes Microsoft return a refresh token.
      scope: 'offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite',
      state: opts.state,
      // Force re-consent in case the user wants to add/change scopes.
      prompt: 'select_account',
    });
    return `${AUTHORIZE_ENDPOINT(opts.tenantId)}?${qs.toString()}`;
  }

  /**
   * Exchange the auth code for tokens, then persist the refresh token
   * + a snapshot of the access token. Called by the OAuth callback.
   */
  async completeCallback(opts: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    mailboxUpn: string;
    connectedByUserId: string;
  }): Promise<OutlookOAuthStatus> {
    const tokens = await this.requestTokens({
      tenantId: opts.tenantId,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        code: opts.code,
        grant_type: 'authorization_code',
        redirect_uri: opts.redirectUri,
      }),
    });
    await this.persistTokens({
      tenantId: opts.tenantId,
      mailboxUpn: opts.mailboxUpn,
      connectedByUserId: opts.connectedByUserId,
      tokens,
    });
    this.logger.log(
      `outlook-oauth: connected mailbox=${opts.mailboxUpn} tenant=${opts.tenantId} by=${opts.connectedByUserId}`,
    );
    return this.getStatus();
  }

  /** Returns a valid access token, refreshing if necessary. */
  async getValidAccessToken(opts: {
    clientId: string;
    clientSecret: string;
  }): Promise<string> {
    const row = await this.prisma.outlookOAuthConnection.findUnique({
      where: { id: SINGLETON_ID },
    });
    if (!row) {
      throw new UnauthorizedException(
        'Outlook is not connected. Visit the org config page and click "Connect Outlook".',
      );
    }
    const key = loadKeyFromEnv();
    const cachedExpiresAt = row.accessTokenExpiresAt?.getTime() ?? 0;
    if (row.accessTokenEncrypted && cachedExpiresAt - Date.now() > ACCESS_TOKEN_SKEW_MS) {
      return decrypt(row.accessTokenEncrypted, key);
    }
    // Need a refresh.
    const refreshToken = decrypt(row.refreshTokenEncrypted, key);
    const tokens = await this.requestTokens({
      tenantId: row.tenantId,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        // Re-state the scope so Microsoft knows we still want offline_access.
        scope:
          'offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite',
      }),
    });
    await this.persistTokens({
      tenantId: row.tenantId,
      mailboxUpn: row.mailboxUpn,
      connectedByUserId: row.connectedByUserId,
      tokens,
    });
    return tokens.access_token;
  }

  async getStatus(): Promise<OutlookOAuthStatus> {
    const row = await this.prisma.outlookOAuthConnection.findUnique({
      where: { id: SINGLETON_ID },
    });
    if (!row) {
      return {
        connected: false,
        mailboxUpn: null,
        tenantId: null,
        connectedAt: null,
        connectedByUserId: null,
        lastRefreshedAt: null,
      };
    }
    return {
      connected: true,
      mailboxUpn: row.mailboxUpn,
      tenantId: row.tenantId,
      connectedAt: row.connectedAt.toISOString(),
      connectedByUserId: row.connectedByUserId,
      lastRefreshedAt: row.lastRefreshedAt?.toISOString() ?? null,
    };
  }

  async disconnect(): Promise<void> {
    await this.prisma.outlookOAuthConnection.deleteMany({ where: { id: SINGLETON_ID } });
    this.logger.log('outlook-oauth: disconnected');
  }

  private async requestTokens(opts: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    body: URLSearchParams;
  }): Promise<TokenExchangeResponse> {
    const res = await fetch(TOKEN_ENDPOINT(opts.tenantId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: opts.body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      this.logger.warn(`outlook-oauth: token request failed ${res.status}: ${text}`);
      throw new UnauthorizedException(`Microsoft token endpoint ${res.status}: ${text}`);
    }
    return JSON.parse(text) as TokenExchangeResponse;
  }

  private async persistTokens(opts: {
    tenantId: string;
    mailboxUpn: string;
    connectedByUserId: string;
    tokens: TokenExchangeResponse;
  }): Promise<void> {
    const key = loadKeyFromEnv();
    const expiresAt = new Date(Date.now() + opts.tokens.expires_in * 1000);
    const data = {
      tenantId: opts.tenantId,
      mailboxUpn: opts.mailboxUpn,
      scope: opts.tokens.scope,
      refreshTokenEncrypted: encrypt(opts.tokens.refresh_token, key),
      accessTokenEncrypted: encrypt(opts.tokens.access_token, key),
      accessTokenExpiresAt: expiresAt,
      lastRefreshedAt: new Date(),
      connectedByUserId: opts.connectedByUserId,
    };
    await this.prisma.outlookOAuthConnection.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });
  }
}
