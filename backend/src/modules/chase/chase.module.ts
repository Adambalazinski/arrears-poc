import { Module } from '@nestjs/common';
import { WorkingDayModule } from '../../common/working-day/working-day.module';
import { ChaseTickService } from './chase-tick.service';
import { DigestService } from './digest/digest.service';
import { ChaseTickJob } from './jobs/chase-tick.job';
import { DailyDigestJob } from './jobs/daily-digest.job';

@Module({
  imports: [WorkingDayModule],
  providers: [ChaseTickService, ChaseTickJob, DigestService, DailyDigestJob],
  exports: [ChaseTickService, ChaseTickJob, DigestService, DailyDigestJob],
})
export class ChaseModule {}
