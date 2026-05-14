import { z } from 'zod';
import { ChaseSkippedReasonSchema, ChaseStageSchema } from './enums';
import { IsoDateTimeSchema, UuidSchema } from './common';

export const ChaseScheduleEntrySchema = z.object({
  id: UuidSchema,
  caseId: UuidSchema,
  chargeId: UuidSchema,
  stage: ChaseStageSchema,
  dueAt: IsoDateTimeSchema,
  firedAt: IsoDateTimeSchema.nullable(),
  skippedReason: ChaseSkippedReasonSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ChaseScheduleEntry = z.infer<typeof ChaseScheduleEntrySchema>;
