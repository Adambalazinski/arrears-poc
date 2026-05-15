import { Module } from '@nestjs/common';
import { WorkingDayModule } from '../../common/working-day/working-day.module';
import { ChaseTickService } from './chase-tick.service';
import { ChaseTickJob } from './jobs/chase-tick.job';

@Module({
  imports: [WorkingDayModule],
  providers: [ChaseTickService, ChaseTickJob],
  exports: [ChaseTickService, ChaseTickJob],
})
export class ChaseModule {}
