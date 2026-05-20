import { Module } from '@nestjs/common';
import { ClockModule } from '../../common/clock/clock.module';
import { AuthModule } from '../auth/auth.module';
import { PromiseExpiryJob } from './jobs/promise-expiry.job';
import { PromisesController } from './promises.controller';
import { PromisesService } from './promises.service';

@Module({
  imports: [ClockModule, AuthModule],
  controllers: [PromisesController],
  providers: [PromisesService, PromiseExpiryJob],
  exports: [PromisesService, PromiseExpiryJob],
})
export class PromisesModule {}
