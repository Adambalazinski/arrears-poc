import { z } from 'zod';
import { ChargeStatusSchema, ChaseStageSchema } from './enums';
import { IsoDateTimeSchema, OrganisationIdSchema, PenceSchema, UuidSchema } from './common';

export const ChargeSchema = z.object({
  id: UuidSchema,
  caseId: UuidSchema,
  organisationId: OrganisationIdSchema,
  lwcaInvoiceId: z.string(),
  dueDate: IsoDateTimeSchema,
  invoiceDate: IsoDateTimeSchema,
  grossAmountPence: PenceSchema,
  lastKnownRemainAmountPence: PenceSchema,
  lastKnownStatus: ChargeStatusSchema,
  lastKnownPaymentCycleType: z.string().nullable(),
  lastSyncedAt: IsoDateTimeSchema,
  currentStage: ChaseStageSchema,
  currentStageEnteredAt: IsoDateTimeSchema.nullable(),
  workingDaysOverdue: z.number().int().nonnegative(),
  stageSteppedBackAt: IsoDateTimeSchema.nullable(),
  stageResetAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Charge = z.infer<typeof ChargeSchema>;
