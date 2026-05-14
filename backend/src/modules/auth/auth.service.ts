import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { RequestUser } from './types';

interface CognitoIdTokenClaims extends JWTPayload {
  sub: string;
  email?: string;
  'cognito:username'?: string;
  token_use?: 'id' | 'access';
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private jwks?: JWTVerifyGetKey;
  private issuer?: string;
  private clientId?: string;

  /**
   * Returns the dev bypass user when DEV_AUTH_BYPASS_USER_ID is set and
   * NODE_ENV is not "production". Returns null in real-auth mode.
   */
  resolveBypassUser(): RequestUser | null {
    if (process.env.NODE_ENV === 'production') return null;
    const id = process.env.DEV_AUTH_BYPASS_USER_ID;
    if (!id) return null;
    return { id, email: 'dev@local' };
  }

  async verifyToken(token: string): Promise<RequestUser> {
    const { jwks, issuer, clientId } = this.getOrInitJwks();
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        // For Cognito access tokens the audience claim isn't set; we verify
        // `client_id` separately below. For id tokens, `aud` is the client id.
      });
      const claims = payload as CognitoIdTokenClaims;
      this.assertClientId(claims, clientId);
      const id = claims.sub;
      const email = claims.email ?? claims['cognito:username'] ?? '';
      if (!id) throw new Error('token missing sub');
      return { id, email };
    } catch (err) {
      this.logger.warn(`token verification failed: ${err instanceof Error ? err.message : err}`);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private assertClientId(claims: CognitoIdTokenClaims, expected: string): void {
    const fromAccess = (claims as { client_id?: string }).client_id;
    const fromId = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
    const actual = fromAccess ?? fromId;
    if (actual !== expected) {
      throw new Error(`token client_id/aud mismatch (got ${actual ?? 'none'})`);
    }
  }

  private getOrInitJwks(): {
    jwks: JWTVerifyGetKey;
    issuer: string;
    clientId: string;
  } {
    if (this.jwks && this.issuer && this.clientId) {
      return { jwks: this.jwks, issuer: this.issuer, clientId: this.clientId };
    }
    const poolId = requireEnv('ARREARS_COGNITO_USER_POOL_ID');
    const clientId = requireEnv('ARREARS_COGNITO_CLIENT_ID');
    const region = poolId.split('_')[0];
    if (!region) throw new Error(`Unparseable Cognito pool id: ${poolId}`);
    const issuer = `https://cognito-idp.${region}.amazonaws.com/${poolId}`;
    const jwksUrl = new URL(`${issuer}/.well-known/jwks.json`);
    this.jwks = createRemoteJWKSet(jwksUrl);
    this.issuer = issuer;
    this.clientId = clientId;
    return { jwks: this.jwks, issuer, clientId };
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`auth: ${name} is required when DEV_AUTH_BYPASS_USER_ID is not set`);
  return v;
}
