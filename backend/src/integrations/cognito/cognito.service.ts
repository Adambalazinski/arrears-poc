import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  NotAuthorizedException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CREDENTIAL_STORE,
  type CredentialStore,
} from '../credential-store/credential-store.interface';
import { CredentialsExpiredError } from './errors';
import { REFRESH_LOCK, type RefreshLock } from './refresh-lock';

export interface CognitoRefreshResult {
  accessToken: string;
  accessTokenExpiresAt: Date;
  /** Cognito only returns a new refresh token when pool-level rotation is on. */
  refreshToken?: string | undefined;
}

// Use the access token if it's still valid for at least this long. Smaller than
// typical clock skew × 2 means we'd hit expiry mid-call; 2 minutes covers it.
const PROACTIVE_REFRESH_WINDOW_MS = 2 * 60_000;

@Injectable()
export class CognitoService {
  private readonly logger = new Logger(CognitoService.name);
  private readonly client: CognitoIdentityProviderClient;
  private readonly clientId: string;

  constructor(
    @Inject(CREDENTIAL_STORE) private readonly credentialStore: CredentialStore,
    @Inject(REFRESH_LOCK) private readonly lock: RefreshLock,
  ) {
    const poolId = requireEnv('COGNITO_USER_POOL_ID');
    const region = poolId.split('_')[0];
    if (!region) throw new Error(`Unparseable upstream Cognito pool id: ${poolId}`);
    this.client = new CognitoIdentityProviderClient({ region });
    this.clientId = requireEnv('COGNITO_CLIENT_ID');
  }

  /** Raw refresh call. Used by withFreshAccessToken; exposed for tests. */
  async refresh(refreshToken: string): Promise<CognitoRefreshResult> {
    const response = await this.client.send(
      new InitiateAuthCommand({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: this.clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    );
    const accessToken = response.AuthenticationResult?.AccessToken;
    const expiresIn = response.AuthenticationResult?.ExpiresIn ?? 3600;
    if (!accessToken) {
      throw new Error('Cognito refresh response missing AccessToken');
    }
    return {
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
      refreshToken: response.AuthenticationResult?.RefreshToken,
    };
  }

  /**
   * Per docs/auth-and-credentials.md. The only entry point for upstream calls
   * needing a Lofty access token. Refreshes transparently when the cached
   * token is within the proactive window. Bumps lastUsedAt.
   */
  async withFreshAccessToken<T>(
    orgId: string,
    fn: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    return this.lock.acquire(orgId, async () => {
      const cred = await this.credentialStore.load(orgId);
      const cutoff = new Date(Date.now() + PROACTIVE_REFRESH_WINDOW_MS);
      const stillValid = cred.accessTokenExpiresAt && cred.accessTokenExpiresAt > cutoff;

      const accessToken = stillValid
        ? await this.credentialStore.decryptAccessToken(cred)
        : await this.doRefresh(orgId, cred.organisationId);

      try {
        const result = await fn(accessToken);
        await this.credentialStore.markUsed(orgId);
        return result;
      } catch (err) {
        // Bubble up; lastUsedAt is reserved for successful upstream calls.
        throw err;
      }
    });
  }

  private async doRefresh(orgId: string, _credId: string): Promise<string> {
    const refreshToken = await this.credentialStore.decryptRefreshToken(
      await this.credentialStore.load(orgId),
    );
    try {
      const { accessToken, accessTokenExpiresAt } = await this.refresh(refreshToken);
      await this.credentialStore.updateAccessToken(orgId, accessToken, accessTokenExpiresAt);
      return accessToken;
    } catch (err) {
      if (isRefreshTokenInvalid(err)) {
        this.logger.warn(`refresh rejected for org ${orgId}: ${(err as Error).message}`);
        throw new CredentialsExpiredError(orgId);
      }
      throw err;
    }
  }
}

function isRefreshTokenInvalid(err: unknown): boolean {
  return err instanceof NotAuthorizedException || err instanceof UserNotFoundException;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Cognito: ${name} env var is required`);
  return v;
}
