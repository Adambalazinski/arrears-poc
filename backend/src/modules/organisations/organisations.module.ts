import { Module } from '@nestjs/common';
import { CredentialStoreModule } from '../../integrations/credential-store/credential-store.module';
import { AuthModule } from '../auth/auth.module';
import { OrganisationConfigService } from './organisation-config.service';
import { OrganisationCredentialService } from './organisation-credential.service';
import { OrganisationsController } from './organisations.controller';
import { OrganisationsService } from './organisations.service';
import { ProbeService } from './probe.service';

@Module({
  imports: [AuthModule, CredentialStoreModule],
  controllers: [OrganisationsController],
  providers: [
    OrganisationsService,
    OrganisationConfigService,
    OrganisationCredentialService,
    ProbeService,
  ],
  exports: [OrganisationsService, OrganisationConfigService, ProbeService],
})
export class OrganisationsModule {}
