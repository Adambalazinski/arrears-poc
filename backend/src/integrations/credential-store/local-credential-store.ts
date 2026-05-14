import { Injectable } from '@nestjs/common';
import type { OrganisationCredential } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt, encrypt, loadKeyFromEnv } from './credential-crypto';
import type { CredentialStore, StoredTokenInput } from './credential-store.interface';

@Injectable()
export class LocalCredentialStore implements CredentialStore {
  private readonly key: Buffer;

  constructor(private readonly prisma: PrismaService) {
    this.key = loadKeyFromEnv();
  }

  async load(orgId: string): Promise<OrganisationCredential> {
    const cred = await this.prisma.organisationCredential.findUnique({
      where: { organisationId: orgId },
    });
    if (!cred) throw new Error(`No credentials stored for organisation ${orgId}`);
    return cred;
  }

  async decryptAccessToken(cred: OrganisationCredential): Promise<string> {
    if (!cred.accessTokenEncrypted) {
      throw new Error(`Credential ${cred.organisationId} has no accessTokenEncrypted blob`);
    }
    return decrypt(Buffer.from(cred.accessTokenEncrypted), this.key);
  }

  async decryptRefreshToken(cred: OrganisationCredential): Promise<string> {
    if (!cred.refreshTokenEncrypted) {
      throw new Error(`Credential ${cred.organisationId} has no refreshTokenEncrypted blob`);
    }
    return decrypt(Buffer.from(cred.refreshTokenEncrypted), this.key);
  }

  async store(orgId: string, input: StoredTokenInput): Promise<void> {
    const accessTokenEncrypted = encrypt(input.accessToken, this.key);
    const refreshTokenEncrypted = encrypt(input.refreshToken, this.key);
    await this.prisma.organisationCredential.upsert({
      where: { organisationId: orgId },
      create: {
        organisationId: orgId,
        storageBackend: 'LOCAL',
        accessTokenEncrypted,
        refreshTokenEncrypted,
        accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
        refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
        createdByUserId: input.createdByUserId,
      },
      update: {
        accessTokenEncrypted,
        refreshTokenEncrypted,
        accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
        refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
        rotatedByUserId: input.createdByUserId,
        rotatedAt: new Date(),
      },
    });
  }

  async updateAccessToken(
    orgId: string,
    accessToken: string,
    expiresAt: Date | null,
    actorUserId: string | null = null,
  ): Promise<void> {
    const accessTokenEncrypted = encrypt(accessToken, this.key);
    await this.prisma.organisationCredential.update({
      where: { organisationId: orgId },
      data: {
        accessTokenEncrypted,
        accessTokenExpiresAt: expiresAt,
        rotatedByUserId: actorUserId,
        rotatedAt: actorUserId ? new Date() : undefined,
      },
    });
  }

  async markUsed(orgId: string): Promise<void> {
    await this.prisma.organisationCredential.update({
      where: { organisationId: orgId },
      data: { lastUsedAt: new Date() },
    });
  }
}
