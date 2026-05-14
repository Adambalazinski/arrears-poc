import { Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { MeController } from './me.controller';

@Module({
  providers: [AuthService, AuthGuard],
  controllers: [MeController],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
