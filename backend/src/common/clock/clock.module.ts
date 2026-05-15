import { Global, Module } from '@nestjs/common';
import { Clock } from './clock.service';

@Global()
@Module({
  providers: [Clock],
  exports: [Clock],
})
export class ClockModule {}
