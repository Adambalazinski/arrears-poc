import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CaseStatus } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { TenancyRefreshService } from '../tenancies/tenancy-refresh.service';
import { CasesService } from './cases.service';
import { LwcaInvoicePollJob } from './jobs/lwca-invoice-poll.job';

@Controller()
@UseGuards(AuthGuard)
export class CasesController {
  constructor(
    private readonly cases: CasesService,
    private readonly pollJob: LwcaInvoicePollJob,
    private readonly tenancyRefresh: TenancyRefreshService,
  ) {}

  @Get('organisations/:orgId/cases')
  list(@Param('orgId') orgId: string, @Query('status') status?: string) {
    const parsed = status && isCaseStatus(status) ? (status as CaseStatus) : undefined;
    return this.cases.list(orgId, parsed);
  }

  /** Dev tool: run the LWCA poll for one organisation right now. */
  @Post('organisations/:orgId/sync')
  @HttpCode(200)
  sync(@Param('orgId') orgId: string) {
    return this.pollJob.runForOrg(orgId);
  }

  @Get('cases/:id')
  detail(@Param('id') id: string) {
    return this.cases.getDetail(id);
  }

  /**
   * Refresh tenant + guarantor data from Rentancy for this case's tenancy.
   * Doesn't re-poll LWCA — the org-level sync endpoint does that.
   */
  @Post('cases/:id/refresh')
  @HttpCode(200)
  async refresh(@Param('id') id: string) {
    const detail = await this.cases.getDetail(id);
    return this.tenancyRefresh.refreshFromRentancy(detail.organisationId, detail.tenancyId);
  }
}

function isCaseStatus(v: string): v is CaseStatus {
  return v === 'ACTIVE' || v === 'CLOSED';
}
