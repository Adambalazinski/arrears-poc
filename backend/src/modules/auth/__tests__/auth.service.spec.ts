import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../auth.service';

describe('AuthService.resolveBypassUser', () => {
  const original = {
    bypass: process.env.DEV_AUTH_BYPASS_USER_ID,
    nodeEnv: process.env.NODE_ENV,
  };

  beforeEach(() => {
    delete process.env.DEV_AUTH_BYPASS_USER_ID;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    if (original.bypass) process.env.DEV_AUTH_BYPASS_USER_ID = original.bypass;
    else delete process.env.DEV_AUTH_BYPASS_USER_ID;
    if (original.nodeEnv) process.env.NODE_ENV = original.nodeEnv;
    else delete process.env.NODE_ENV;
  });

  it('returns null when DEV_AUTH_BYPASS_USER_ID is unset', () => {
    expect(new AuthService().resolveBypassUser()).toBeNull();
  });

  it('returns the dev user when bypass is set in non-production', () => {
    process.env.DEV_AUTH_BYPASS_USER_ID = '11111111-1111-1111-1111-111111111111';
    const user = new AuthService().resolveBypassUser();
    expect(user).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'dev@local',
    });
  });

  it('ignores bypass entirely when NODE_ENV=production', () => {
    process.env.DEV_AUTH_BYPASS_USER_ID = '11111111-1111-1111-1111-111111111111';
    process.env.NODE_ENV = 'production';
    expect(new AuthService().resolveBypassUser()).toBeNull();
  });
});
