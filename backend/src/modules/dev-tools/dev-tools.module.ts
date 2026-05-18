import { Module } from '@nestjs/common';
import { ClockModule } from '../../common/clock/clock.module';
import { WorkingDayModule } from '../../common/working-day/working-day.module';
import { AuthModule } from '../auth/auth.module';
import { ChaseModule } from '../chase/chase.module';
import { InboundModule } from '../inbound/inbound.module';
import { DevToolsController } from './dev-tools.controller';
import { SeedFixtureEmailsService } from './seed-fixture-emails.service';

@Module({
  imports: [AuthModule, ChaseModule, WorkingDayModule, ClockModule, InboundModule],
  controllers: [DevToolsController],
  providers: [SeedFixtureEmailsService],
})
export class DevToolsModule {}
