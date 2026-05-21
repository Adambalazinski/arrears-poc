import { Module } from '@nestjs/common';
import { WorkingDayModule } from '../../common/working-day/working-day.module';
import { ChargesService } from './charges.service';

@Module({
  imports: [WorkingDayModule],
  providers: [ChargesService],
  exports: [ChargesService],
})
export class ChargesModule {}
