import { Module, type Provider } from '@nestjs/common';
import { CognitoModule } from '../cognito/cognito.module';
import { CognitoService } from '../cognito/cognito.service';
import { FixtureLwcaInvoiceClient } from './fixture-lwca-invoice.client';
import { HttpLwcaInvoiceClient } from './http-lwca-invoice.client';
import { LWCA_INVOICE_CLIENT } from './lwca-invoice.client';

const lwcaInvoiceClientProvider: Provider = {
  provide: LWCA_INVOICE_CLIENT,
  inject: [CognitoService],
  useFactory: (cognito: CognitoService) => {
    const mode = (process.env.INTEGRATION_MODE ?? 'fixtures').toLowerCase();
    if (mode === 'stage') return new HttpLwcaInvoiceClient(cognito);
    if (mode === 'fixtures') return new FixtureLwcaInvoiceClient();
    throw new Error(`Unknown INTEGRATION_MODE="${mode}" (expected stage or fixtures)`);
  },
};

@Module({
  imports: [CognitoModule],
  providers: [lwcaInvoiceClientProvider],
  exports: [lwcaInvoiceClientProvider],
})
export class LwcaModule {}
