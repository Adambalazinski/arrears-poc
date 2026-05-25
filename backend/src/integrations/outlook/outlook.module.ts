import { Module, type Provider } from '@nestjs/common';
import { AuthModule } from '../../modules/auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MailhogMailer } from './mailhog-mailer';
import { OutlookGraphClient } from './outlook-graph-client';
import { OutlookOAuthController } from './outlook-oauth.controller';
import { OutlookOAuthService } from './outlook-oauth.service';
import { OUTLOOK_CLIENT } from './outlook.types';

const outlookClientProvider: Provider = {
  provide: OUTLOOK_CLIENT,
  useFactory: (oauth: OutlookOAuthService) => {
    const mode = (process.env.OUTBOUND_MODE ?? 'mailhog').toLowerCase();
    if (mode === 'mailhog') return new MailhogMailer();
    if (mode === 'outlook') return new OutlookGraphClient(oauth);
    throw new Error(`Unknown OUTBOUND_MODE="${mode}" (expected mailhog or outlook)`);
  },
  inject: [OutlookOAuthService],
};

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [OutlookOAuthController],
  providers: [outlookClientProvider, OutlookOAuthService],
  exports: [outlookClientProvider, OutlookOAuthService],
})
export class OutlookModule {}
