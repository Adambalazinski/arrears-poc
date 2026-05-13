# Auth and Credentials

How Arrears authenticates users and how it authenticates itself to upstream services. Short doc; the schema is in `docs/canonical-data-model.md` and the integration mechanics are in `docs/integrations.md`. This doc is about the lifecycle and the moving parts.

## Two distinct auth surfaces

**Arrears users (humans logging into the Arrears app).** A dedicated Cognito user pool, owned by Arrears. Internal staff invited manually for POC. Standard JWT bearer flow.

**Upstream service calls (machine).** Per-organisation. Stored in the `OrganisationCredential` table, scoped to a configured organisation. Used by the polling worker, by case-detail refresh actions, by credential probes. The Arrears user's JWT is *never* propagated to LWCA or Rentancy.

These two surfaces are completely separate and don't share infrastructure beyond both being Cognito-flavoured.

## Arrears user auth

POC scope is small enough that we can keep this simple.

**User pool.** A separate Arrears Cognito user pool. Staff invited by email. MFA is on by default in Cognito but optional in POC (we'll keep it on; setup is one extra step at sign-in).

**Token usage.** Standard `Authorization: Bearer <accessToken>` on all `/api/*` calls. NestJS `AuthGuard` (`@nestjs/passport` + `passport-jwt`) validates against the JWKS endpoint. Extracts `userId` and `email` into `req.user`.

**Local dev bypass.** `DEV_AUTH_BYPASS_USER_ID=<uuid>` skips JWT verification and sets `req.user = { id: <uuid>, email: 'dev@local' }`. Hard-coded "off" when `NODE_ENV=production`.

**Roles.** Single role for POC (`ARREARS_STAFF`). Role-based UI gating not needed yet; all authenticated users see all cases for all configured orgs. Future: per-org membership and admin/staff split.

## Upstream service auth

The hard problem: the worker needs to call LWCA + Rentancy as the organisation's service user, every few minutes, without human involvement. Refresh tokens make this work.

### Credential lifecycle

```
1. Admin user opens config page for an organisation
2. Pastes: access token + refresh token
3. Save:
     a. Validate-via-probe: GET /v1/api/invoice?limit=1 + GET /v2/organisations/{orgId}/tenancies?limit=1
     b. If either fails: show error, do not persist
     c. If both succeed: encrypt both tokens, write OrganisationCredential row
4. Worker starts polling for this org on next tick
5. Time passes; access token nears expiry
6. withFreshAccessToken(orgId) refreshes transparently before next upstream call
7. Refresh token itself approaches its 30-day expiry
8. TokenExpiryWarningJob raises a banner 7 days before
9. Admin returns to config page, pastes new tokens, repeats from step 3
```

### `withFreshAccessToken` — the only call path

Every upstream client call goes through this:

```ts
async function withFreshAccessToken<T>(
  orgId: string,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  return await refreshLock.acquire(`${orgId}:token-refresh`, async () => {
    const cred = await credentialStore.load(orgId);

    if (cred.accessTokenExpiresAt && cred.accessTokenExpiresAt > new Date(Date.now() + 2 * 60_000)) {
      // Still valid for at least 2 minutes — use as-is
      const accessToken = await credentialStore.decryptAccessToken(cred);
      return fn(accessToken);
    }

    // Refresh required
    const refreshToken = await credentialStore.decryptRefreshToken(cred);
    try {
      const { accessToken, accessTokenExpiresAt } = await cognitoRefresh(refreshToken);
      await credentialStore.updateAccessToken(orgId, accessToken, accessTokenExpiresAt);
      return fn(accessToken);
    } catch (e) {
      if (isRefreshTokenInvalid(e)) {
        await escalationService.raiseOrgFlag(orgId, 'CREDENTIALS_EXPIRED');
        await pollingControl.halt(orgId);
        throw new CredentialsExpiredError(orgId);
      }
      throw e;
    }
  });
}
```

`refreshLock.acquire(key, fn)` uses a Postgres advisory lock so two parallel callers requesting a refresh for the same org don't both hit Cognito with the same refresh token.

### Cognito refresh call

```ts
async function cognitoRefresh(refreshToken: string) {
  const response = await cognitoClient.send(new InitiateAuthCommand({
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: process.env.UPSTREAM_COGNITO_CLIENT_ID!,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  }));
  const accessToken = response.AuthenticationResult?.AccessToken;
  const expiresIn = response.AuthenticationResult?.ExpiresIn ?? 3600;
  return {
    accessToken,
    accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}
```

Cognito's `REFRESH_TOKEN_AUTH` returns a new access token but does not rotate the refresh token. Refresh-token rotation (where each refresh issues a new refresh token) is a Cognito pool setting; if Lofty's pool has it enabled, the response's `RefreshToken` will be populated and we persist it. The store handles both cases.

### Retry on 401 mid-call

If an upstream call returns 401 even though our access token wasn't expiring (clock skew, revoked token, etc):

```
1. Force-refresh once (clear expiresAt to force refresh on next withFreshAccessToken call)
2. Retry the original call
3. On second 401: surface as CredentialsExpiredError, raise CREDENTIALS_EXPIRED flag
```

### Refresh-token expiry warning

`TokenExpiryWarningJob` runs daily. For each `OrganisationCredential`:

```
if (refreshTokenExpiresAt - now) < 7 days:
    surface a banner on the config page
    log warning
```

If the pool doesn't expose refresh token expiry in the token itself (Cognito refresh tokens are opaque, not JWTs), we don't have a precise expiry. Fallback: treat `createdAt + poolRefreshLifetime` as expiry, where `poolRefreshLifetime` is a config constant matching the pool setting.

If we don't know the pool setting either: skip the warning, just rely on the first failed refresh to raise the flag. Worse UX but not unsafe.

## Credential storage

Per `docs/canonical-data-model.md` and `docs/architecture.md`. Two backends:

**Local (`CredentialStorageBackend.LOCAL`).** Tokens stored AES-256-GCM encrypted in `accessTokenEncrypted` / `refreshTokenEncrypted` Bytes columns. The encryption key comes from `CREDENTIAL_ENCRYPTION_KEY` env var (base64-encoded 32-byte key).

```ts
import crypto from 'crypto';
const KEY = Buffer.from(process.env.CREDENTIAL_ENCRYPTION_KEY!, 'base64');
// AES-256-GCM with random IV per encryption; IV+tag prepended to ciphertext
```

**Hosted (`CredentialStorageBackend.SECRETS_MANAGER`).** The `OrganisationCredential` row stores only the `secretArn`. The secret value is a JSON object:

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "accessTokenExpiresAt": "2025-05-13T14:30:00Z",
  "refreshTokenExpiresAt": "2025-06-10T14:30:00Z"
}
```

Secrets Manager handles encryption at rest with KMS. The backend's IAM role has `secretsmanager:GetSecretValue` + `secretsmanager:PutSecretValue` on `arrears/{env}/org/*`.

`CredentialStore` is a single interface; the implementation is wired by env var. Service code never branches on storage backend.

```ts
interface CredentialStore {
  load(orgId: string): Promise<OrganisationCredential>;
  decryptAccessToken(cred: OrganisationCredential): Promise<string>;
  decryptRefreshToken(cred: OrganisationCredential): Promise<string>;
  store(orgId: string, accessToken: string, refreshToken: string, ...): Promise<void>;
  updateAccessToken(orgId: string, accessToken: string, expiresAt: Date): Promise<void>;
}
```

### Why per-org and not a single Lofty-wide token

We considered one master Arrears service account that has access to all orgs on LWCA. Rejected because:

1. Lofty's user pool is per-organisation in practice (a user belongs to one org)
2. Per-org credentials let an admin enable/disable Arrears for a specific org without cross-org impact
3. Audit on the LWCA side shows actions per organisation's service user, not as one shared identity
4. If a credential leaks, blast radius is one org

The cost is admins repeat the credential setup per org. That's acceptable for POC scale.

## Audit

Every `withFreshAccessToken` call updates `OrganisationCredential.lastUsedAt`. Useful for spotting an org where polling has been silently failing — `lastUsedAt` would lag.

Every credential write (initial setup, rotation) records `createdByUserId` / `rotatedByUserId` and timestamps. The user who last touched credentials is visible on the config page.

## Outlook auth (different path, included for completeness)

Outlook isn't per-organisation. One shared Lofty mailbox serves all configured orgs. Auth is via Microsoft Graph SDK using `ClientSecretCredential`:

```
OUTLOOK_TENANT_ID         // Azure AD tenant
OUTLOOK_CLIENT_ID         // App registration client id
OUTLOOK_CLIENT_SECRET     // App registration secret
OUTLOOK_SHARED_MAILBOX    // UPN of the mailbox
```

Tokens are managed by the SDK (acquire-and-cache, no manual refresh). Stored as app-level env vars locally, in Secrets Manager hosted. Not in `OrganisationCredential`.

## Anthropic auth

Single API key for the Arrears app. `ANTHROPIC_API_KEY` env var. Not per-organisation. Spend is allocated per call to whichever org's case triggered it, so we can break down costs in reporting; but auth is app-level.

## Open items

- **Cognito pool sharing between LWCA and Rentancy** — assumed shared; confirm at first probe. If separate, `OrganisationCredential` needs two token pairs and `withFreshAccessToken` takes a `target` parameter.
- **Cognito refresh token expiry duration** — needs confirmation from Lofty platform team to set `poolRefreshLifetime`.
- **Cognito client secret** — Lofty's stage app client may or may not have a secret. If it does, we need it in env. If not (public client), we use the SRP-less REFRESH_TOKEN_AUTH flow as written.
- **Initial token acquisition** — admins need to know how to get their initial access + refresh token pair to paste in. We probably need a short admin guide doc that walks through "log into Lofty stage, capture the tokens from devtools" or "use the Lofty CLI" — depends on what tooling Lofty exposes.
