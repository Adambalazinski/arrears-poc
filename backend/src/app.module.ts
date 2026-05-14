import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppLoggerModule } from './common/logger/logger.module';
import { WorkingDayModule } from './common/working-day/working-day.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './integrations/prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { CasesModule } from './modules/cases/cases.module';
import { OrganisationsModule } from './modules/organisations/organisations.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AppLoggerModule,
    WorkingDayModule,
    AuthModule,
    OrganisationsModule,
    CasesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
