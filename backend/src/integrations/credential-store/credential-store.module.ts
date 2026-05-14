import { Module, type Provider } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CREDENTIAL_STORE } from './credential-store.interface';
import { LocalCredentialStore } from './local-credential-store';
import { SecretsManagerCredentialStore } from './secrets-manager-credential-store';

const credentialStoreProvider: Provider = {
  provide: CREDENTIAL_STORE,
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) => {
    const backend = (process.env.CREDENTIAL_STORAGE_BACKEND ?? 'LOCAL').toUpperCase();
    switch (backend) {
      case 'LOCAL':
        return new LocalCredentialStore(prisma);
      case 'SECRETS_MANAGER':
        return new SecretsManagerCredentialStore();
      default:
        throw new Error(
          `Unknown CREDENTIAL_STORAGE_BACKEND="${backend}" (expected LOCAL or SECRETS_MANAGER)`,
        );
    }
  },
};

@Module({
  imports: [PrismaModule],
  providers: [credentialStoreProvider],
  exports: [credentialStoreProvider],
})
export class CredentialStoreModule {}
