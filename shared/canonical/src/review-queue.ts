import { z } from 'zod';
import {
  ReviewItemKindSchema,
  ReviewItemPrioritySchema,
  ReviewItemResolutionSchema,
} from './enums';
import { IsoDateTimeSchema, OrganisationIdSchema, UuidSchema } from './common';

export const ReviewQueueItemSchema = z.object({
  id: UuidSchema,
  organisationId: OrganisationIdSchema,
  caseId: UuidSchema,
  kind: ReviewItemKindSchema,
  communicationId: UuidSchema.nullable(),
  classificationResultId: UuidSchema.nullable(),
  priority: ReviewItemPrioritySchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
  resolvedByUserId: UuidSchema.nullable(),
  resolution: ReviewItemResolutionSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;
