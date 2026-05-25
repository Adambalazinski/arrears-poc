import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Redirect,
  UseGuards,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuthGuard } from '../../modules/auth/auth.guard';
import { CurrentUser } from '../../modules/auth/current-user.decorator';
import type { RequestUser } from '../../modules/auth/types';
import { OutlookOAuthService } from './outlook-oauth.service';

/**
 * Delegated-OAuth endpoints for connecting the app's shared Outlook
 * mailbox. The flow is:
 *
 *   1. `GET /auth/outlook/initiate?mailboxUpn=…` — returns the
 *      Microsoft authorize URL the browser must redirect to. We
 *      generate a random `state` and stash it in memory for the
 *      callback to verify.
 *   2. User consents in their browser, Microsoft redirects to
 *      `/auth/outlook/callback?code=…&state=…`.
 *   3. We swap the code for tokens, persist the refresh token, and
 *      redirect the browser back to the frontend with `?connected=1`.
 *   4. `GET /auth/outlook/status` — for the UI to poll/check.
 *   5. `POST /auth/outlook/disconnect` — clears the singleton row.
 */
@Controller('auth/outlook')
export class OutlookOAuthController {
  private readonly logger = new Logger(OutlookOAuthController.name);
  // state → { mailboxUpn, userId, createdAt }
  private readonly pendingStates = new Map<
    string,
    { mailboxUpn: string; userId: string; createdAt: number }
  >();

  constructor(private readonly oauth: OutlookOAuthService) {}

  @Get('initiate')
  @UseGuards(AuthGuard)
  initiate(
    @Query('mailboxUpn') mailboxUpn: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    if (!mailboxUpn || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailboxUpn)) {
      throw new BadRequestException('mailboxUpn (a valid email) is required');
    }
    const tenantId = requireEnv('OUTLOOK_TENANT_ID');
    const clientId = requireEnv('OUTLOOK_CLIENT_ID');
    const redirectUri = requireEnv('OUTLOOK_REDIRECT_URI');
    const state = randomBytes(16).toString('hex');
    this.pendingStates.set(state, {
      mailboxUpn,
      userId: user.id,
      createdAt: Date.now(),
    });
    // GC any state older than 10 min — they're useless after Microsoft's
    // own 10-min authorize-code lifetime anyway.
    for (const [k, v] of this.pendingStates) {
      if (Date.now() - v.createdAt > 10 * 60 * 1000) this.pendingStates.delete(k);
    }
    const url = this.oauth.buildAuthorizeUrl({ tenantId, clientId, redirectUri, state });
    return { authorizeUrl: url };
  }

  /**
   * Hit by Microsoft (not by the frontend directly). Since the redirect
   * URI is registered on the Azure app, this endpoint is unauthenticated
   * from our side — the `state` parameter is what we use to bind the
   * callback back to the user who initiated it.
   */
  @Get('callback')
  @Redirect()
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
  ): Promise<{ url: string }> {
    const frontendBase = process.env.OUTLOOK_FRONTEND_BASE ?? 'http://localhost:5173';
    if (error) {
      this.logger.warn(`outlook-oauth: callback error ${error}: ${errorDescription}`);
      return { url: `${frontendBase}/?outlook_connect_error=${encodeURIComponent(error)}` };
    }
    if (!code || !state) {
      throw new BadRequestException('Missing code or state in callback');
    }
    const pending = this.pendingStates.get(state);
    if (!pending) {
      throw new BadRequestException('Unknown or expired state — re-initiate the connection');
    }
    this.pendingStates.delete(state);

    const tenantId = requireEnv('OUTLOOK_TENANT_ID');
    const clientId = requireEnv('OUTLOOK_CLIENT_ID');
    const clientSecret = requireEnv('OUTLOOK_CLIENT_SECRET');
    const redirectUri = requireEnv('OUTLOOK_REDIRECT_URI');

    await this.oauth.completeCallback({
      tenantId,
      clientId,
      clientSecret,
      redirectUri,
      code,
      mailboxUpn: pending.mailboxUpn,
      connectedByUserId: pending.userId,
    });
    return { url: `${frontendBase}/?outlook_connected=1` };
  }

  @Get('status')
  @UseGuards(AuthGuard)
  status() {
    return this.oauth.getStatus();
  }

  @Post('disconnect')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async disconnect() {
    await this.oauth.disconnect();
    return { ok: true };
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Outlook OAuth: ${name} env var is required`);
  return v;
}
