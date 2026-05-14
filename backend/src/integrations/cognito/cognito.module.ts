import { Module, type Provider } from '@nestjs/common';
import { CredentialStoreModule } from '../credential-store/credential-store.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CognitoService } from './cognito.service';
import { PostgresAdvisoryRefreshLock, REFRESH_LOCK } from './refresh-lock';

const refreshLockProvider: Provider = {
  provide: REFRESH_LOCK,
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) => new PostgresAdvisoryRefreshLock(prisma),
};

@Module({
  imports: [PrismaModule, CredentialStoreModule],
  providers: [refreshLockProvider, CognitoService],
  exports: [CognitoService],
})
export class CognitoModule {}
