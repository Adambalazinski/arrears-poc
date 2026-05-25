import { Module } from '@nestjs/common';
import { ClockModule } from '../../common/clock/clock.module';
import { LwcaModule } from '../../integrations/lwca/lwca.module';
import { AuthModule } from '../auth/auth.module';
import { ChargesModule } from '../charges/charges.module';
import { ChaseModule } from '../chase/chase.module';
import { TenanciesModule } from '../tenancies/tenancies.module';
import { BreathingSpaceService } from './breathing-space.service';
import { CasesController } from './cases.controller';
import { CasesService } from './cases.service';
import { LwcaInvoicePollJob } from './jobs/lwca-invoice-poll.job';
import { S8EvaluationService } from './s8-evaluation.service';

@Module({
  imports: [AuthModule, LwcaModule, ChargesModule, TenanciesModule, ChaseModule, ClockModule],
  controllers: [CasesController],
  providers: [CasesService, LwcaInvoicePollJob, S8EvaluationService, BreathingSpaceService],
  exports: [CasesService, LwcaInvoicePollJob, S8EvaluationService, BreathingSpaceService],
})
export class CasesModule {}
