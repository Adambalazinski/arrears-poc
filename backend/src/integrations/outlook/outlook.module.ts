import { Module, type Provider } from '@nestjs/common';
import { MailhogMailer } from './mailhog-mailer';
import { OutlookGraphClient } from './outlook-graph-client';
import { OUTLOOK_CLIENT } from './outlook.types';

const outlookClientProvider: Provider = {
  provide: OUTLOOK_CLIENT,
  useFactory: () => {
    const mode = (process.env.OUTBOUND_MODE ?? 'mailhog').toLowerCase();
    if (mode === 'mailhog') return new MailhogMailer();
    if (mode === 'outlook') return new OutlookGraphClient();
    throw new Error(`Unknown OUTBOUND_MODE="${mode}" (expected mailhog or outlook)`);
  },
};

@Module({
  providers: [outlookClientProvider],
  exports: [outlookClientProvider],
})
export class OutlookModule {}
