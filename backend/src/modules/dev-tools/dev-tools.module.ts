import { Module } from '@nestjs/common';
import { ClockModule } from '../../common/clock/clock.module';
import { WorkingDayModule } from '../../common/working-day/working-day.module';
import { LwcaModule } from '../../integrations/lwca/lwca.module';
import { AuthModule } from '../auth/auth.module';
import { CasesModule } from '../cases/cases.module';
import { ChaseModule } from '../chase/chase.module';
import { InboundModule } from '../inbound/inbound.module';
import { PromisesModule } from '../promises/promises.module';
import { DevToolsController } from './dev-tools.controller';
import { PurgeNonRentService } from './purge-non-rent.service';
import { SeedFixtureEmailsService } from './seed-fixture-emails.service';

@Module({
  imports: [
    AuthModule,
    CasesModule,
    ChaseModule,
    WorkingDayModule,
    ClockModule,
    InboundModule,
    PromisesModule,
    LwcaModule,
  ],
  controllers: [DevToolsController],
  providers: [SeedFixtureEmailsService, PurgeNonRentService],
})
export class DevToolsModule {}
