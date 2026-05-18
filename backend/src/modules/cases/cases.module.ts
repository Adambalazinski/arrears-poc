import { Module } from '@nestjs/common';
import { LwcaModule } from '../../integrations/lwca/lwca.module';
import { AuthModule } from '../auth/auth.module';
import { ChargesModule } from '../charges/charges.module';
import { TenanciesModule } from '../tenancies/tenancies.module';
import { CasesController } from './cases.controller';
import { CasesService } from './cases.service';
import { LwcaInvoicePollJob } from './jobs/lwca-invoice-poll.job';
import { S8EvaluationService } from './s8-evaluation.service';

@Module({
  imports: [AuthModule, LwcaModule, ChargesModule, TenanciesModule],
  controllers: [CasesController],
  providers: [CasesService, LwcaInvoicePollJob, S8EvaluationService],
  exports: [CasesService, LwcaInvoicePollJob, S8EvaluationService],
})
export class CasesModule {}
