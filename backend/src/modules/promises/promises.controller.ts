import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodBody } from '../../common/zod/zod-validation.pipe';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';
import { PromisesService } from './promises.service';

const CreatePromiseSchema = z.object({
  promiseDate: z.string().datetime(),
  note: z.string().max(500).optional(),
  sourceInboundCommunicationId: z.string().uuid().optional(),
});

const ResolvePromiseSchema = z.object({
  note: z.string().max(500).optional(),
});

@Controller()
@UseGuards(AuthGuard)
export class PromisesController {
  constructor(private readonly promises: PromisesService) {}

  @Post('cases/:id/promises')
  @HttpCode(200)
  create(
    @Param('id') caseId: string,
    @Body(new ZodBody(CreatePromiseSchema)) dto: z.infer<typeof CreatePromiseSchema>,
    @CurrentUser() user: RequestUser,
  ) {
    return this.promises.create({
      caseId,
      promiseDate: new Date(dto.promiseDate),
      note: dto.note,
      sourceInboundCommunicationId: dto.sourceInboundCommunicationId,
      createdByUserId: user.id,
    });
  }

  @Post('promises/:id/fulfill')
  @HttpCode(200)
  fulfill(
    @Param('id') promiseId: string,
    @Body(new ZodBody(ResolvePromiseSchema)) dto: z.infer<typeof ResolvePromiseSchema>,
    @CurrentUser() user: RequestUser,
  ) {
    return this.promises.markFulfilled({
      promiseId,
      resolvedByUserId: user.id,
      note: dto.note,
    });
  }

  @Post('promises/:id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id') promiseId: string,
    @Body(new ZodBody(ResolvePromiseSchema)) dto: z.infer<typeof ResolvePromiseSchema>,
    @CurrentUser() user: RequestUser,
  ) {
    return this.promises.cancel({
      promiseId,
      resolvedByUserId: user.id,
      note: dto.note,
    });
  }
}
