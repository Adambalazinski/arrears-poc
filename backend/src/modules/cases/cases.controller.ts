import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CaseStatus } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { CasesService } from './cases.service';

@Controller()
@UseGuards(AuthGuard)
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Get('organisations/:orgId/cases')
  list(@Param('orgId') orgId: string, @Query('status') status?: string) {
    const parsed = status && isCaseStatus(status) ? (status as CaseStatus) : undefined;
    return this.cases.list(orgId, parsed);
  }

  @Get('cases/:id')
  detail(@Param('id') id: string) {
    return this.cases.getDetail(id);
  }
}

function isCaseStatus(v: string): v is CaseStatus {
  return v === 'ACTIVE' || v === 'CLOSED';
}
