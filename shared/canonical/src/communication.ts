import { z } from 'zod';
import {
  ChaseStageSchema,
  CommunicationChannelSchema,
  CommunicationDirectionSchema,
  CommunicationStatusSchema,
  RecipientRoleSchema,
} from './enums';
import { IsoDateTimeSchema, JsonValueSchema, OrganisationIdSchema, UuidSchema } from './common';

export const CommunicationSchema = z.object({
  id: UuidSchema,
  caseId: UuidSchema,
  organisationId: OrganisationIdSchema,
  direction: CommunicationDirectionSchema,
  channel: CommunicationChannelSchema,
  status: CommunicationStatusSchema,

  toAddress: z.string().email().nullable(),
  recipientRole: RecipientRoleSchema.nullable(),
  subject: z.string().nullable(),
  bodyMarkdown: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  consolidatedStage: ChaseStageSchema.nullable(),
  draftedByAi: z.boolean(),

  fromAddress: z.string().email().nullable(),
  receivedAt: IsoDateTimeSchema.nullable(),
  outlookMessageId: z.string().nullable(),
  rawBodyText: z.string().nullable(),

  approvedByUserId: UuidSchema.nullable(),
  approvedAt: IsoDateTimeSchema.nullable(),
  rejectedByUserId: UuidSchema.nullable(),
  rejectedAt: IsoDateTimeSchema.nullable(),
  rejectionReason: z.string().nullable(),

  sentAt: IsoDateTimeSchema.nullable(),
  outlookSentMessageId: z.string().nullable(),
  sendErrorJson: JsonValueSchema.nullable(),

  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Communication = z.infer<typeof CommunicationSchema>;
