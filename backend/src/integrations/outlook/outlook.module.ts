import { Module, type Provider } from '@nestjs/common';
import { AuthModule } from '../../modules/auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ImapSmtpClient } from './imap-smtp-client';
import { ImapSmtpController } from './imap-smtp.controller';
import { ImapSmtpService } from './imap-smtp.service';
import { MailhogMailer } from './mailhog-mailer';
import { OutlookGraphClient } from './outlook-graph-client';
import { OutlookOAuthController } from './outlook-oauth.controller';
import { OutlookOAuthService } from './outlook-oauth.service';
import { OUTLOOK_CLIENT } from './outlook.types';

/**
 * OUTBOUND_MODE picks which OutlookClient implementation backs the
 * outbound + inbound surface:
 *   - mailhog (default): MailhogMailer — local SMTP via Docker
 *   - outlook:           OutlookGraphClient — Microsoft Graph
 *   - gmail:             ImapSmtpClient — generic IMAP+SMTP, defaults to
 *                        gmail's hosts but takes anything (Fastmail, etc.)
 *
 * Inbound is gated separately via INBOUND_MODE on the poll job;
 * this factory only chooses the implementation backing the
 * read+write methods.
 */
const outlookClientProvider: Provider = {
  provide: OUTLOOK_CLIENT,
  useFactory: (oauth: OutlookOAuthService, imap: ImapSmtpService) => {
    const mode = (process.env.OUTBOUND_MODE ?? 'mailhog').toLowerCase();
    if (mode === 'mailhog') return new MailhogMailer();
    if (mode === 'outlook') return new OutlookGraphClient(oauth);
    if (mode === 'gmail') return new ImapSmtpClient(imap);
    throw new Error(
      `Unknown OUTBOUND_MODE="${mode}" (expected mailhog | outlook | gmail)`,
    );
  },
  inject: [OutlookOAuthService, ImapSmtpService],
};

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [OutlookOAuthController, ImapSmtpController],
  providers: [outlookClientProvider, OutlookOAuthService, ImapSmtpService],
  exports: [outlookClientProvider, OutlookOAuthService, ImapSmtpService],
})
export class OutlookModule {}
