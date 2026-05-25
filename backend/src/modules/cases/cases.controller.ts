import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CaseStatus } from '@prisma/client';
import { z } from 'zod';
import { ZodBody } from '../../common/zod/zod-validation.pipe';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';
import { TenancyRefreshService } from '../tenancies/tenancy-refresh.service';
import { BreathingSpaceService } from './breathing-space.service';
import { CasesService } from './cases.service';
import { LwcaInvoicePollJob } from './jobs/lwca-invoice-poll.job';

const SetHandlerSchema = z.object({
  // null = unassign; string = explicit user id (Cognito sub or local dev id).
  handlerUserId: z.string().min(1).nullable(),
});

const ActivateBreathingSpaceSchema = z.object({
  source: z.enum(['FORMAL_NOTIFICATION', 'TENANT_EMAIL_MENTION']),
  note: z.string().max(500).optional(),
});

const DeactivateBreathingSpaceSchema = z.object({
  note: z.string().max(500).optional(),
});

@Controller()
@UseGuards(AuthGuard)
export class CasesController {
  constructor(
    private readonly cases: CasesService,
    private readonly pollJob: LwcaInvoicePollJob,
    private readonly tenancyRefresh: TenancyRefreshService,
    private readonly breathingSpace: BreathingSpaceService,
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

  @Post('cases/:id/breathing-space/activate')
  @HttpCode(200)
  activateBreathingSpace(
    @Param('id') id: string,
    @Body(new ZodBody(ActivateBreathingSpaceSchema))
    dto: z.infer<typeof ActivateBreathingSpaceSchema>,
  ) {
    return this.breathingSpace.activate({ caseId: id, source: dto.source, note: dto.note });
  }

  @Patch('cases/:id/handler')
  @HttpCode(200)
  setHandler(
    @Param('id') id: string,
    @Body(new ZodBody(SetHandlerSchema)) dto: z.infer<typeof SetHandlerSchema>,
    @CurrentUser() user: RequestUser,
  ) {
    return this.cases.setHandler({
      caseId: id,
      handlerUserId: dto.handlerUserId,
      actorUserId: user.id,
    });
  }

  @Post('cases/:id/breathing-space/deactivate')
  @HttpCode(200)
  deactivateBreathingSpace(
    @Param('id') id: string,
    @Body(new ZodBody(DeactivateBreathingSpaceSchema))
    dto: z.infer<typeof DeactivateBreathingSpaceSchema>,
  ) {
    return this.breathingSpace.deactivate({ caseId: id, note: dto.note });
  }
}

function isCaseStatus(v: string): v is CaseStatus {
  return v === 'ACTIVE' || v === 'CLOSED';
}
