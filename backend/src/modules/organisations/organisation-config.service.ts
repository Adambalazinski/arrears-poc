import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type OrganisationConfig } from '@prisma/client';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import type { UpdateOrganisationConfigDto } from './dto';

@Injectable()
export class OrganisationConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async get(organisationId: string): Promise<OrganisationConfig> {
    const config = await this.prisma.organisationConfig.findUnique({
      where: { organisationId },
    });
    if (!config) {
      throw new NotFoundException(`No config for organisation ${organisationId}`);
    }
    return config;
  }

  async update(
    organisationId: string,
    dto: UpdateOrganisationConfigDto,
  ): Promise<OrganisationConfig> {
    await this.get(organisationId);
    return this.prisma.organisationConfig.update({
      where: { organisationId },
      data: toPrismaUpdate(dto),
    });
  }
}

function toPrismaUpdate(dto: UpdateOrganisationConfigDto): Prisma.OrganisationConfigUpdateInput {
  const data: Prisma.OrganisationConfigUpdateInput = {};
  if (dto.chaseDayFirst !== undefined) data.chaseDayFirst = dto.chaseDayFirst;
  if (dto.chaseDaySecond !== undefined) data.chaseDaySecond = dto.chaseDaySecond;
  if (dto.chaseDayThird !== undefined) data.chaseDayThird = dto.chaseDayThird;
  if (dto.chaseDayExecNotify !== undefined) data.chaseDayExecNotify = dto.chaseDayExecNotify;
  if (dto.workingDayCalendar !== undefined) data.workingDayCalendar = dto.workingDayCalendar;
  if (dto.s8RentMonthsThreshold !== undefined) data.s8RentMonthsThreshold = dto.s8RentMonthsThreshold;
  if (dto.s8WeeksThreshold !== undefined) data.s8WeeksThreshold = dto.s8WeeksThreshold;
  if (dto.pollingIntervalMinutes !== undefined) data.pollingIntervalMinutes = dto.pollingIntervalMinutes;
  if (dto.autoSendEnabled !== undefined) data.autoSendEnabled = dto.autoSendEnabled;
  if (dto.aiClassificationModel !== undefined) data.aiClassificationModel = dto.aiClassificationModel;
  if (dto.aiDraftModel !== undefined) data.aiDraftModel = dto.aiDraftModel;
  if (dto.aiConfidenceThreshold !== undefined) {
    data.aiConfidenceThreshold = new Prisma.Decimal(dto.aiConfidenceThreshold);
  }
  if (dto.templateWd3Tenant !== undefined) data.templateWd3Tenant = dto.templateWd3Tenant;
  if (dto.templateWd5Tenant !== undefined) data.templateWd5Tenant = dto.templateWd5Tenant;
  if (dto.templateWd8Tenant !== undefined) data.templateWd8Tenant = dto.templateWd8Tenant;
  if (dto.templateWd14Tenant !== undefined) data.templateWd14Tenant = dto.templateWd14Tenant;
  if (dto.templateBrokenPromise !== undefined) data.templateBrokenPromise = dto.templateBrokenPromise;
  if (dto.hardTriggerOverrides !== undefined) {
    data.hardTriggerOverrides =
      dto.hardTriggerOverrides === null
        ? Prisma.JsonNull
        : (dto.hardTriggerOverrides as Prisma.InputJsonValue);
  }
  return data;
}
