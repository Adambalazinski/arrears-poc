import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodBody } from '../../common/zod/zod-validation.pipe';
import { AuthGuard } from '../../modules/auth/auth.guard';
import { CurrentUser } from '../../modules/auth/current-user.decorator';
import type { RequestUser } from '../../modules/auth/types';
import { ImapSmtpService } from './imap-smtp.service';

const ConnectSchema = z.object({
  mailboxAddress: z.string().email(),
  appPassword: z.string().min(8),
  imapHost: z.string().optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
});

/**
 * Endpoints for the IMAP+SMTP mailbox connection. Parallel to
 * /auth/outlook/* — same singleton-ish shape, but uses an App
 * Password rather than OAuth.
 */
@Controller('auth/imap-smtp')
@UseGuards(AuthGuard)
export class ImapSmtpController {
  constructor(private readonly svc: ImapSmtpService) {}

  @Post('connect')
  @HttpCode(200)
  async connect(
    @Body(new ZodBody(ConnectSchema)) dto: z.infer<typeof ConnectSchema>,
    @CurrentUser() user: RequestUser,
  ) {
    if (!dto.mailboxAddress || !dto.appPassword) {
      throw new BadRequestException('mailboxAddress + appPassword are required');
    }
    return this.svc.connect({
      ...dto,
      connectedByUserId: user.id,
    });
  }

  @Get('status')
  status() {
    return this.svc.getStatus();
  }

  @Post('disconnect')
  @HttpCode(200)
  async disconnect() {
    await this.svc.disconnect();
    return { ok: true };
  }
}
