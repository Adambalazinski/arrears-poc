import { randomBytes } from 'node:crypto';
import type { OrganisationCredential } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { LocalCredentialStore } from '../local-credential-store';

const ORIG_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY;

function makeStore(): { store: LocalCredentialStore; prisma: ReturnType<typeof fakePrisma> } {
  const prisma = fakePrisma();
  const store = new LocalCredentialStore(prisma as unknown as PrismaService);
  return { store, prisma };
}

function fakePrisma() {
  return {
    organisationCredential: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
  };
}

beforeEach(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

afterEach(() => {
  if (ORIG_KEY) process.env.CREDENTIAL_ENCRYPTION_KEY = ORIG_KEY;
  else delete process.env.CREDENTIAL_ENCRYPTION_KEY;
});

describe('LocalCredentialStore', () => {
  it('encrypts tokens on store() and round-trips them on decrypt*()', async () => {
    const { store, prisma } = makeStore();
    let stored: OrganisationCredential | null = null;
    prisma.organisationCredential.upsert.mockImplementation(async ({ create }) => {
      stored = {
        ...create,
        rotatedAt: null,
        rotatedByUserId: null,
        lastUsedAt: null,
        createdAt: new Date(),
        secretArn: null,
        accessTokenExpiresAt: create.accessTokenExpiresAt ?? null,
        refreshTokenExpiresAt: create.refreshTokenExpiresAt ?? null,
      } as OrganisationCredential;
      return stored;
    });

    await store.store('org-1', {
      accessToken: 'access-abc-123',
      refreshToken: 'refresh-xyz-456',
      createdByUserId: 'user-1',
    });

    expect(stored).not.toBeNull();
    expect(stored!.accessTokenEncrypted).toBeInstanceOf(Buffer);
    expect(stored!.refreshTokenEncrypted).toBeInstanceOf(Buffer);
    expect(stored!.accessTokenEncrypted!.toString('utf-8')).not.toContain('access-abc-123');

    prisma.organisationCredential.findUnique.mockResolvedValue(stored);
    const loaded = await store.load('org-1');
    expect(await store.decryptAccessToken(loaded)).toBe('access-abc-123');
    expect(await store.decryptRefreshToken(loaded)).toBe('refresh-xyz-456');
  });

  it('fails decryption when the key changes between store and read', async () => {
    const { store, prisma } = makeStore();
    let stored: OrganisationCredential | null = null;
    prisma.organisationCredential.upsert.mockImplementation(async ({ create }) => {
      stored = {
        ...create,
        rotatedAt: null,
        rotatedByUserId: null,
        lastUsedAt: null,
        createdAt: new Date(),
        secretArn: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
      } as OrganisationCredential;
      return stored;
    });
    await store.store('org-1', {
      accessToken: 'access',
      refreshToken: 'refresh',
      createdByUserId: 'u',
    });

    // Rotate the key and rebuild a store that reads back the same blob.
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const rotated = new LocalCredentialStore(prisma as unknown as PrismaService);

    await expect(rotated.decryptAccessToken(stored!)).rejects.toThrow(/decryption failed/);
  });

  it('throws when load() finds nothing', async () => {
    const { store, prisma } = makeStore();
    prisma.organisationCredential.findUnique.mockResolvedValue(null);
    await expect(store.load('missing')).rejects.toThrow(/No credentials stored/);
  });

  it('refuses to construct with an absent encryption key', () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => new LocalCredentialStore({} as PrismaService)).toThrow(
      /CREDENTIAL_ENCRYPTION_KEY/,
    );
  });
});
