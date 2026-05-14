import { Module } from '@nestjs/common';
import { ChargesService } from './charges.service';

@Module({
  providers: [ChargesService],
  exports: [ChargesService],
})
export class ChargesModule {}
