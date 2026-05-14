import { z } from 'zod';
import { EscalationFlagKindSchema } from './enums';
import { IsoDateTimeSchema, JsonValueSchema, UuidSchema } from './common';

export const EscalationFlagSchema = z.object({
  id: UuidSchema,
  caseId: UuidSchema,
  kind: EscalationFlagKindSchema,
  payloadJson: JsonValueSchema.nullable(),
  raisedAt: IsoDateTimeSchema,
  raisedReason: z.string(),
  resolvedAt: IsoDateTimeSchema.nullable(),
  resolvedReason: z.string().nullable(),
});
export type EscalationFlag = z.infer<typeof EscalationFlagSchema>;
