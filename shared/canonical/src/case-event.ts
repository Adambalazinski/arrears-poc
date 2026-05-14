import { z } from 'zod';
import { CaseEventKindSchema } from './enums';
import { IsoDateTimeSchema, JsonValueSchema, UuidSchema } from './common';

export const CaseEventSchema = z.object({
  id: UuidSchema,
  caseId: UuidSchema,
  kind: CaseEventKindSchema,
  payloadJson: JsonValueSchema,
  actorUserId: UuidSchema.nullable(),
  occurredAt: IsoDateTimeSchema,
});
export type CaseEvent = z.infer<typeof CaseEventSchema>;
