import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest, RequestUser } from './types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.user) {
      throw new Error('CurrentUser used on an unauthenticated route');
    }
    return req.user;
  },
);
