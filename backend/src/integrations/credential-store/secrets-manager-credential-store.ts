import { Injectable } from '@nestjs/common';
import type { OrganisationCredential } from '@prisma/client';
import type { CredentialStore, StoredTokenInput } from './credential-store.interface';

/**
 * Hosted POC backend. The OrganisationCredential row stores only `secretArn`;
 * the secret value (JSON `{ accessToken, refreshToken, accessTokenExpiresAt,
 * refreshTokenExpiresAt }`) lives in AWS Secrets Manager. The implementation
 * lands when we deploy the hosted POC — for now this class exists so the
 * provider can be wired by env and the interface is enforced.
 */
@Injectable()
export class SecretsManagerCredentialStore implements CredentialStore {
  load(_orgId: string): Promise<OrganisationCredential> {
    return Promise.reject(new Error('SecretsManagerCredentialStore.load not implemented'));
  }

  decryptAccessToken(_cred: OrganisationCredential): Promise<string> {
    return Promise.reject(
      new Error('SecretsManagerCredentialStore.decryptAccessToken not implemented'),
    );
  }

  decryptRefreshToken(_cred: OrganisationCredential): Promise<string> {
    return Promise.reject(
      new Error('SecretsManagerCredentialStore.decryptRefreshToken not implemented'),
    );
  }

  store(_orgId: string, _input: StoredTokenInput): Promise<void> {
    return Promise.reject(new Error('SecretsManagerCredentialStore.store not implemented'));
  }

  updateAccessToken(
    _orgId: string,
    _accessToken: string,
    _expiresAt: Date | null,
    _actorUserId?: string | null,
  ): Promise<void> {
    return Promise.reject(
      new Error('SecretsManagerCredentialStore.updateAccessToken not implemented'),
    );
  }

  markUsed(_orgId: string): Promise<void> {
    return Promise.reject(new Error('SecretsManagerCredentialStore.markUsed not implemented'));
  }
}
