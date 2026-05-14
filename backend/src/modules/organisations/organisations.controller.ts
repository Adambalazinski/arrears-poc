import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ZodBody } from '../../common/zod/zod-validation.pipe';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';
import {
  CreateOrganisationSchema,
  ProbeCredentialsSchema,
  StoreCredentialsSchema,
  UpdateOrganisationConfigSchema,
  UpdateOrganisationSchema,
  type CreateOrganisationDto,
  type ProbeCredentialsDto,
  type StoreCredentialsDto,
  type UpdateOrganisationConfigDto,
  type UpdateOrganisationDto,
} from './dto';
import { OrganisationConfigService } from './organisation-config.service';
import { OrganisationCredentialService } from './organisation-credential.service';
import { OrganisationsService } from './organisations.service';

@Controller('organisations')
@UseGuards(AuthGuard)
export class OrganisationsController {
  constructor(
    private readonly orgs: OrganisationsService,
    private readonly configs: OrganisationConfigService,
    private readonly credentials: OrganisationCredentialService,
  ) {}

  @Get()
  list() {
    return this.orgs.list();
  }

  @Post()
  create(@Body(new ZodBody(CreateOrganisationSchema)) dto: CreateOrganisationDto) {
    return this.orgs.create(dto);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.orgs.get(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodBody(UpdateOrganisationSchema)) dto: UpdateOrganisationDto,
  ) {
    return this.orgs.update(id, dto);
  }

  @Get(':id/config')
  getConfig(@Param('id') id: string) {
    return this.configs.get(id);
  }

  @Patch(':id/config')
  updateConfig(
    @Param('id') id: string,
    @Body(new ZodBody(UpdateOrganisationConfigSchema)) dto: UpdateOrganisationConfigDto,
  ) {
    return this.configs.update(id, dto);
  }

  @Get(':id/credentials')
  getCredentials(@Param('id') id: string) {
    return this.credentials.getSummary(id);
  }

  @Post(':id/credentials')
  storeCredentials(
    @Param('id') id: string,
    @Body(new ZodBody(StoreCredentialsSchema)) dto: StoreCredentialsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.credentials.store(id, user.id, dto);
  }

  @Post(':id/credentials/probe')
  probeCredentials(
    @Param('id') id: string,
    @Body(new ZodBody(ProbeCredentialsSchema)) dto: ProbeCredentialsDto,
  ) {
    return this.credentials.probeOnly(id, dto.accessToken);
  }
}
