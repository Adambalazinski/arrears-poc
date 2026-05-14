import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { OrganisationCredential } from '@prisma/client';
import {
  CREDENTIAL_STORE,
  type CredentialStore,
} from '../../integrations/credential-store/credential-store.interface';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import type { StoreCredentialsDto } from './dto';
import { ProbeService, type ProbeResult } from './probe.service';

export interface CredentialSummary {
  organisationId: string;
  storageBackend: OrganisationCredential['storageBackend'];
  accessTokenMask: string | null;
  refreshTokenMask: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  createdAt: Date;
  createdByUserId: string;
  rotatedAt: Date | null;
  rotatedByUserId: string | null;
  lastUsedAt: Date | null;
}

export interface StoreCredentialResult {
  probe: ProbeResult;
  saved: boolean;
  reason?: string;
}

@Injectable()
export class OrganisationCredentialService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CREDENTIAL_STORE) private readonly credentialStore: CredentialStore,
    private readonly probeService: ProbeService,
  ) {}

  async getSummary(organisationId: string): Promise<CredentialSummary | null> {
    const cred = await this.prisma.organisationCredential.findUnique({
      where: { organisationId },
    });
    if (!cred) return null;
    return {
      organisationId: cred.organisationId,
      storageBackend: cred.storageBackend,
      accessTokenMask: cred.accessTokenEncrypted ? '••••••••' : null,
      refreshTokenMask: cred.refreshTokenEncrypted ? '••••••••' : null,
      accessTokenExpiresAt: cred.accessTokenExpiresAt,
      refreshTokenExpiresAt: cred.refreshTokenExpiresAt,
      createdAt: cred.createdAt,
      createdByUserId: cred.createdByUserId,
      rotatedAt: cred.rotatedAt,
      rotatedByUserId: cred.rotatedByUserId,
      lastUsedAt: cred.lastUsedAt,
    };
  }

  /**
   * Probe-then-store. Per docs/auth-and-credentials.md: a successful probe is
   * the precondition for persistence; the build-plan Phase 2.2 carve-out
   * allows `allowFailedProbe: true` so admins can save before the upstream
   * integrations are wired (or against a stub).
   */
  async store(
    organisationId: string,
    actorUserId: string,
    dto: StoreCredentialsDto,
  ): Promise<StoreCredentialResult> {
    await this.assertOrganisationExists(organisationId);
    const probe = await this.probeService.probe(organisationId, dto.accessToken);
    if (probe.overall !== 'OK' && !dto.allowFailedProbe) {
      return {
        probe,
        saved: false,
        reason: 'Probe did not return OK; pass allowFailedProbe=true to override',
      };
    }
    await this.credentialStore.store(organisationId, {
      accessToken: dto.accessToken,
      refreshToken: dto.refreshToken,
      accessTokenExpiresAt: dto.accessTokenExpiresAt
        ? new Date(dto.accessTokenExpiresAt)
        : null,
      refreshTokenExpiresAt: dto.refreshTokenExpiresAt
        ? new Date(dto.refreshTokenExpiresAt)
        : null,
      createdByUserId: actorUserId,
    });
    return { probe, saved: true };
  }

  async probeOnly(organisationId: string, accessToken: string): Promise<ProbeResult> {
    await this.assertOrganisationExists(organisationId);
    if (!accessToken) throw new BadRequestException('accessToken is required');
    return this.probeService.probe(organisationId, accessToken);
  }

  private async assertOrganisationExists(organisationId: string): Promise<void> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { id: true },
    });
    if (!org) throw new NotFoundException(`Organisation ${organisationId} not found`);
  }
}
