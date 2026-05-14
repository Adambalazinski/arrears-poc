import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Organisation } from '@prisma/client';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import { DEFAULT_ORG_CONFIG } from './defaults';
import type { CreateOrganisationDto, UpdateOrganisationDto } from './dto';

@Injectable()
export class OrganisationsService {
  constructor(private readonly prisma: PrismaService) {}

  list(): Promise<Organisation[]> {
    return this.prisma.organisation.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async get(id: string): Promise<Organisation> {
    const org = await this.prisma.organisation.findUnique({ where: { id } });
    if (!org) throw new NotFoundException(`Organisation ${id} not found`);
    return org;
  }

  /**
   * Creating an organisation also creates its OrganisationConfig with TLP BRD
   * defaults. We do this atomically so an org never exists without a config —
   * downstream services (config loader, polling) treat that as an invariant.
   */
  async create(dto: CreateOrganisationDto): Promise<Organisation> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const org = await tx.organisation.create({
          data: { id: dto.id, name: dto.name },
        });
        await tx.organisationConfig.create({
          data: {
            ...DEFAULT_ORG_CONFIG,
            organisation: { connect: { id: org.id } },
          },
        });
        return org;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Organisation ${dto.id} already exists`);
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateOrganisationDto): Promise<Organisation> {
    await this.get(id);
    return this.prisma.organisation.update({
      where: { id },
      data: { name: dto.name ?? undefined },
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'P2002'
  );
}
