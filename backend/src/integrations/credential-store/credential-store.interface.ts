import type { OrganisationCredential } from '@prisma/client';

export interface StoredTokenInput {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt?: Date | null;
  refreshTokenExpiresAt?: Date | null;
  createdByUserId: string;
}

/**
 * Per docs/auth-and-credentials.md. Two concrete implementations: LOCAL
 * (AES-256-GCM blobs in Postgres) and SECRETS_MANAGER (ARN -> JSON secret).
 * Service code never branches on backend; only the DI provider does.
 */
export interface CredentialStore {
  load(orgId: string): Promise<OrganisationCredential>;
  decryptAccessToken(cred: OrganisationCredential): Promise<string>;
  decryptRefreshToken(cred: OrganisationCredential): Promise<string>;
  store(orgId: string, input: StoredTokenInput): Promise<void>;
  updateAccessToken(
    orgId: string,
    accessToken: string,
    expiresAt: Date | null,
    actorUserId?: string | null,
  ): Promise<void>;
  /** Bump lastUsedAt — called inside withFreshAccessToken on every upstream call. */
  markUsed(orgId: string): Promise<void>;
}

export const CREDENTIAL_STORE = Symbol('CREDENTIAL_STORE');

export class CredentialDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialDecryptionError';
  }
}
