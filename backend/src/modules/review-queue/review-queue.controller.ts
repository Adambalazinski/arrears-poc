import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ZodBody } from '../../common/zod/zod-validation.pipe';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';
import { ApproveSchema, RejectSchema, type ApproveDto, type RejectDto } from './dto';
import { ReviewQueueService } from './review-queue.service';

@Controller('review-queue')
@UseGuards(AuthGuard)
export class ReviewQueueController {
  constructor(private readonly service: ReviewQueueService) {}

  @Get()
  list(@Query('organisationId') organisationId: string) {
    return this.service.list(organisationId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @Param('id') id: string,
    @Body(new ZodBody(ApproveSchema)) body: ApproveDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.approve(id, user.id, body.editedBodyMarkdown);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @Param('id') id: string,
    @Body(new ZodBody(RejectSchema)) body: RejectDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.reject(id, user.id, body.reason);
  }
}
