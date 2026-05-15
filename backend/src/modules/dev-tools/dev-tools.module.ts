import { Module } from '@nestjs/common';
import { WorkingDayModule } from '../../common/working-day/working-day.module';
import { AuthModule } from '../auth/auth.module';
import { ChaseModule } from '../chase/chase.module';
import { DevToolsController } from './dev-tools.controller';

@Module({
  imports: [AuthModule, ChaseModule, WorkingDayModule],
  controllers: [DevToolsController],
})
export class DevToolsModule {}
