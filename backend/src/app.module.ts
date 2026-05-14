import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppLoggerModule } from './common/logger/logger.module';
import { WorkingDayModule } from './common/working-day/working-day.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    AppLoggerModule,
    WorkingDayModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
