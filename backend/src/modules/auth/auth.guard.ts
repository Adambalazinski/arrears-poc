import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import type { AuthenticatedRequest, RequestUser } from './types';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & Partial<AuthenticatedRequest>>();

    const bypass = this.auth.resolveBypassUser();
    if (bypass) {
      req.user = bypass;
      return true;
    }

    const token = extractBearer(req);
    if (!token) throw new UnauthorizedException('Missing bearer token');
    const user: RequestUser = await this.auth.verifyToken(token);
    req.user = user;
    return true;
  }
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value;
}
