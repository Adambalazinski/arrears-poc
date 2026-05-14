import { z } from 'zod';
import { CaseStatusSchema } from './enums';
import { IsoDateTimeSchema, OrganisationIdSchema, PenceSchema, UuidSchema } from './common';

export const CaseSchema = z.object({
  id: UuidSchema,
  organisationId: OrganisationIdSchema,
  tenancyId: UuidSchema,
  status: CaseStatusSchema,
  openedAt: IsoDateTimeSchema,
  closedAt: IsoDateTimeSchema.nullable(),
  lastKnownBalancePence: PenceSchema,
  lastKnownBalanceAt: IsoDateTimeSchema,
  s8Eligible: z.boolean(),
  breathingSpaceActive: z.boolean(),
  awaitingHandlerAction: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Case = z.infer<typeof CaseSchema>;
