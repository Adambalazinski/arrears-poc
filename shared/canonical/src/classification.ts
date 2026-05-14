import { z } from 'zod';
import { EscalationFlagKindSchema, InboundIntentSchema, SentimentSchema } from './enums';
import { IsoDateTimeSchema, UuidSchema } from './common';

export const ClassificationResultSchema = z.object({
  id: UuidSchema,
  caseId: UuidSchema,
  communicationId: UuidSchema,

  preFilterMatched: z.boolean(),
  preFilterTriggerKind: EscalationFlagKindSchema.nullable(),
  preFilterMatchedKeyword: z.string().nullable(),

  modelUsed: z.string().nullable(),
  sentiment: SentimentSchema.nullable(),
  intent: InboundIntentSchema.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  rationale: z.string().nullable(),
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  estimatedCostPence: z.number().int().nonnegative().nullable(),

  createdAt: IsoDateTimeSchema,
});
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;
