import { Module } from '@nestjs/common';
import { BankHolidaysLoader } from './bank-holidays.loader';
import { WorkingDayService } from './working-day.service';

@Module({
  providers: [BankHolidaysLoader, WorkingDayService],
  exports: [WorkingDayService],
})
export class WorkingDayModule {}
