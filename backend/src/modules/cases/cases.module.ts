import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CasesController } from './cases.controller';
import { CasesService } from './cases.service';

@Module({
  imports: [AuthModule],
  controllers: [CasesController],
  providers: [CasesService],
  exports: [CasesService],
})
export class CasesModule {}
