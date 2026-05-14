import { Module } from '@nestjs/common';
import { LwcaModule } from '../../integrations/lwca/lwca.module';
import { AuthModule } from '../auth/auth.module';
import { ChargesModule } from '../charges/charges.module';
import { CasesController } from './cases.controller';
import { CasesService } from './cases.service';
import { LwcaInvoicePollJob } from './jobs/lwca-invoice-poll.job';

@Module({
  imports: [AuthModule, LwcaModule, ChargesModule],
  controllers: [CasesController],
  providers: [CasesService, LwcaInvoicePollJob],
  exports: [CasesService, LwcaInvoicePollJob],
})
export class CasesModule {}
