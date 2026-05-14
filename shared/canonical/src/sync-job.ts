import { z } from 'zod';
import { SyncJobKindSchema, SyncJobStatusSchema } from './enums';
import { IsoDateTimeSchema, JsonValueSchema, OrganisationIdSchema, UuidSchema } from './common';

export const SyncJobRunSchema = z.object({
  id: UuidSchema,
  organisationId: OrganisationIdSchema,
  kind: SyncJobKindSchema,
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  status: SyncJobStatusSchema,
  itemsProcessed: z.number().int().nonnegative(),
  itemsCreated: z.number().int().nonnegative(),
  itemsUpdated: z.number().int().nonnegative(),
  errorJson: JsonValueSchema.nullable(),
});
export type SyncJobRun = z.infer<typeof SyncJobRunSchema>;
