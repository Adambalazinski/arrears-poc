import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import type { RequestUser } from './types';

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  @Get()
  me(@CurrentUser() user: RequestUser): RequestUser {
    return user;
  }
}
