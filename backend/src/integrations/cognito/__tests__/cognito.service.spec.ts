import type { OrganisationCredential } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from '../../credential-store/credential-store.interface';
import type { RefreshLock } from '../refresh-lock';

// Stub the AWS SDK so we don't need credentials or networking. The service
// uses InitiateAuthCommand only for its constructor (carrying input) and
// `instanceof NotAuthorizedException` for error classification — both work
// against these local stand-ins because the service imports the same mocked
// module we wire here. Names hoisted via vi.hoisted so the factory can see
// them (vi.mock is hoisted ahead of module init).
const { sendMock, MockInitiateAuthCommand, MockNotAuthorizedException } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  MockInitiateAuthCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
  MockNotAuthorizedException: class extends Error {
    $metadata = {};
    override name = 'NotAuthorizedException';
  },
}));

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  InitiateAuthCommand: MockInitiateAuthCommand,
  NotAuthorizedException: MockNotAuthorizedException,
  UserNotFoundException: class extends Error {
    $metadata = {};
    override name = 'UserNotFoundException';
  },
}));

import { CognitoService } from '../cognito.service';
import { CredentialsExpiredError } from '../errors';

const ORIG_ENV = { pool: process.env.COGNITO_USER_POOL_ID, client: process.env.COGNITO_CLIENT_ID };

beforeEach(() => {
  sendMock.mockReset();
  process.env.COGNITO_USER_POOL_ID = 'eu-west-1_TestPool';
  process.env.COGNITO_CLIENT_ID = 'client-id-test';
});

afterEach(() => {
  if (ORIG_ENV.pool) process.env.COGNITO_USER_POOL_ID = ORIG_ENV.pool;
  else delete process.env.COGNITO_USER_POOL_ID;
  if (ORIG_ENV.client) process.env.COGNITO_CLIENT_ID = ORIG_ENV.client;
  else delete process.env.COGNITO_CLIENT_ID;
});

function passthroughLock(): RefreshLock {
  return { acquire: (_key, fn) => fn() };
}

interface FakeStoreState {
  cred: OrganisationCredential;
  decryptedAccess: string;
  decryptedRefresh: string;
  markUsedCalls: number;
}

function makeStore(initial: {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date | null;
}): { store: CredentialStore; state: FakeStoreState } {
  const state: FakeStoreState = {
    cred: {
      organisationId: 'org-1',
      storageBackend: 'LOCAL',
      accessTokenEncrypted: Buffer.from('enc-access'),
      refreshTokenEncrypted: Buffer.from('enc-refresh'),
      secretArn: null,
      accessTokenExpiresAt: initial.accessTokenExpiresAt,
      refreshTokenExpiresAt: null,
      createdByUserId: 'u',
      createdAt: new Date(),
      rotatedByUserId: null,
      rotatedAt: null,
      lastUsedAt: null,
    },
    decryptedAccess: initial.accessToken,
    decryptedRefresh: initial.refreshToken,
    markUsedCalls: 0,
  };
  const store: CredentialStore = {
    load: vi.fn(async () => state.cred),
    decryptAccessToken: vi.fn(async () => state.decryptedAccess),
    decryptRefreshToken: vi.fn(async () => state.decryptedRefresh),
    store: vi.fn(),
    updateAccessToken: vi.fn(async (_org, accessToken, expiresAt) => {
      state.decryptedAccess = accessToken;
      state.cred = { ...state.cred, accessTokenExpiresAt: expiresAt };
    }),
    markUsed: vi.fn(async () => {
      state.markUsedCalls++;
    }),
  };
  return { store, state };
}

describe('CognitoService.refresh', () => {
  it('returns a new access token + expiry from REFRESH_TOKEN_AUTH', async () => {
    sendMock.mockResolvedValueOnce({
      AuthenticationResult: { AccessToken: 'new-access', ExpiresIn: 3600 },
    });
    const svc = new CognitoService({} as CredentialStore, passthroughLock());
    const result = await svc.refresh('refresh-token-1');
    expect(result.accessToken).toBe('new-access');
    expect(result.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0]![0] as InstanceType<typeof MockInitiateAuthCommand>;
    expect(cmd.input.AuthFlow).toBe('REFRESH_TOKEN_AUTH');
    expect(cmd.input.ClientId).toBe('client-id-test');
    expect(cmd.input.AuthParameters).toEqual({ REFRESH_TOKEN: 'refresh-token-1' });
  });

  it('throws when AccessToken is missing from the response', async () => {
    sendMock.mockResolvedValueOnce({ AuthenticationResult: {} });
    const svc = new CognitoService({} as CredentialStore, passthroughLock());
    await expect(svc.refresh('rt')).rejects.toThrow(/missing AccessToken/);
  });
});

describe('CognitoService.withFreshAccessToken', () => {
  it('reuses a still-valid access token without calling Cognito', async () => {
    const { store, state } = makeStore({
      accessToken: 'cached-access',
      refreshToken: 'rt',
      accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const svc = new CognitoService(store, passthroughLock());
    const result = await svc.withFreshAccessToken('org-1', async (token) => {
      expect(token).toBe('cached-access');
      return 'fn-result';
    });
    expect(result).toBe('fn-result');
    expect(sendMock).not.toHaveBeenCalled();
    expect(state.markUsedCalls).toBe(1);
  });

  it('refreshes when the access token is expiring soon', async () => {
    sendMock.mockResolvedValueOnce({
      AuthenticationResult: { AccessToken: 'refreshed-access', ExpiresIn: 3600 },
    });
    const { store, state } = makeStore({
      accessToken: 'cached-access',
      refreshToken: 'rt',
      accessTokenExpiresAt: new Date(Date.now() + 30_000), // < 2 min window
    });
    const svc = new CognitoService(store, passthroughLock());
    const observed: string[] = [];
    await svc.withFreshAccessToken('org-1', async (token) => {
      observed.push(token);
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(observed).toEqual(['refreshed-access']);
    expect(state.decryptedAccess).toBe('refreshed-access');
    expect(state.markUsedCalls).toBe(1);
  });

  it('raises CredentialsExpiredError on NotAuthorizedException', async () => {
    sendMock.mockRejectedValueOnce(new MockNotAuthorizedException('Refresh Token has expired'));
    const { store } = makeStore({
      accessToken: 'cached-access',
      refreshToken: 'rt-bad',
      accessTokenExpiresAt: new Date(Date.now() - 60_000), // already expired
    });
    const svc = new CognitoService(store, passthroughLock());
    await expect(
      svc.withFreshAccessToken('org-1', async () => 'never'),
    ).rejects.toBeInstanceOf(CredentialsExpiredError);
  });

  it('serializes parallel refresh requests for the same org through the lock', async () => {
    // Two callers, both arriving when the access token is expired. Without the
    // lock both would hit Cognito; with the lock, the second sees the freshly
    // updated token and skips the SDK call.
    sendMock.mockResolvedValueOnce({
      AuthenticationResult: { AccessToken: 'refreshed-once', ExpiresIn: 3600 },
    });

    const { store } = makeStore({
      accessToken: 'cached-access',
      refreshToken: 'rt',
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    });

    // Real per-key serialization in JS — same contract as the Postgres
    // advisory lock from the service's point of view.
    const lock: RefreshLock = inMemoryLock();
    const svc = new CognitoService(store, lock);

    const observed: string[] = [];
    await Promise.all([
      svc.withFreshAccessToken('org-1', async (token) => {
        observed.push(`a:${token}`);
      }),
      svc.withFreshAccessToken('org-1', async (token) => {
        observed.push(`b:${token}`);
      }),
    ]);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(observed.sort()).toEqual(['a:refreshed-once', 'b:refreshed-once']);
  });
});

function inMemoryLock(): RefreshLock {
  const tails = new Map<string, Promise<unknown>>();
  return {
    async acquire(key, fn) {
      const prev = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((r) => (release = r));
      tails.set(
        key,
        prev.then(() => next),
      );
      try {
        await prev;
        return await fn();
      } finally {
        release();
        if (tails.get(key) === next) tails.delete(key);
      }
    },
  };
}
