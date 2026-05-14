import { z } from 'zod';

export const TenancyStatusSchema = z.enum(['ACTIVE', 'ENDED', 'UNKNOWN']);
export type TenancyStatus = z.infer<typeof TenancyStatusSchema>;

export const ContactRoleSchema = z.enum(['TENANT', 'GUARANTOR']);
export type ContactRole = z.infer<typeof ContactRoleSchema>;

export const CaseStatusSchema = z.enum(['ACTIVE', 'CLOSED']);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const ChargeStatusSchema = z.enum([
  'UNPAID',
  'PARTIALLY_PAID',
  'PARTIALLY_RECONCILED',
  'PAID',
  'RECONCILED',
  'DELETED',
  'PAYMENT_PROCESSING',
]);
export type ChargeStatus = z.infer<typeof ChargeStatusSchema>;

export const ChaseStageSchema = z.enum([
  'NOT_DUE',
  'AWAITING_WD3',
  'WD3_SENT',
  'AWAITING_WD5',
  'WD5_SENT',
  'AWAITING_WD8',
  'WD8_SENT',
  'AWAITING_WD14',
  'WD14_NOTIFIED',
  'RESOLVED',
]);
export type ChaseStage = z.infer<typeof ChaseStageSchema>;

export const ChaseSkippedReasonSchema = z.enum([
  'BREATHING_SPACE_ACTIVE',
  'CHARGE_RESOLVED',
  'CASE_CLOSED',
  'AUTOSEND_DISABLED_AND_DRAFT_REJECTED',
]);
export type ChaseSkippedReason = z.infer<typeof ChaseSkippedReasonSchema>;

export const CaseEventKindSchema = z.enum([
  'CASE_OPENED',
  'CASE_CLOSED',
  'CHARGE_ADDED',
  'CHARGE_SYNCED',
  'CHARGE_FULLY_PAID',
  'CHARGE_PARTIALLY_PAID',
  'CHASE_STAGE_ADVANCED',
  'CHASE_EVENT_FIRED',
  'COMMUNICATION_DRAFTED',
  'COMMUNICATION_APPROVED',
  'COMMUNICATION_REJECTED',
  'COMMUNICATION_SENT',
  'COMMUNICATION_RECEIVED',
  'CLASSIFICATION_PRODUCED',
  'HARD_TRIGGER_MATCHED',
  'ESCALATION_FLAG_RAISED',
  'ESCALATION_FLAG_CLEARED',
  'BREATHING_SPACE_ACTIVATED',
  'BREATHING_SPACE_DEACTIVATED',
  'S8_ELIGIBILITY_RAISED',
  'S8_ELIGIBILITY_RESCINDED',
  'HANDLER_ASSIGNED',
]);
export type CaseEventKind = z.infer<typeof CaseEventKindSchema>;

export const CommunicationDirectionSchema = z.enum(['INBOUND', 'OUTBOUND']);
export type CommunicationDirection = z.infer<typeof CommunicationDirectionSchema>;

export const CommunicationChannelSchema = z.enum(['EMAIL', 'WHATSAPP']);
export type CommunicationChannel = z.infer<typeof CommunicationChannelSchema>;

export const CommunicationStatusSchema = z.enum([
  'DRAFTED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SENT',
  'SEND_FAILED',
  'REJECTED',
  'AUTO_REJECTED',
  'RECEIVED',
  'PROCESSED',
]);
export type CommunicationStatus = z.infer<typeof CommunicationStatusSchema>;

export const RecipientRoleSchema = z.enum(['TENANT', 'GUARANTOR']);
export type RecipientRole = z.infer<typeof RecipientRoleSchema>;

export const ReviewItemKindSchema = z.enum([
  'OUTBOUND_DRAFT_APPROVAL',
  'INBOUND_LOW_CONFIDENCE',
  'HARD_TRIGGER_ESCALATION',
]);
export type ReviewItemKind = z.infer<typeof ReviewItemKindSchema>;

export const ReviewItemPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export type ReviewItemPriority = z.infer<typeof ReviewItemPrioritySchema>;

export const ReviewItemResolutionSchema = z.enum([
  'APPROVED_AND_SENT',
  'EDITED_AND_SENT',
  'REJECTED',
  'HANDLER_ACTIONED',
  'DISMISSED',
]);
export type ReviewItemResolution = z.infer<typeof ReviewItemResolutionSchema>;

export const EscalationFlagKindSchema = z.enum([
  'S8_ELIGIBLE',
  'BREATHING_SPACE',
  'HARDSHIP_INDICATED',
  'MENTAL_HEALTH_INDICATED',
  'THIRD_PARTY_INVOLVED',
  'LIABILITY_DISPUTED',
  'DOMESTIC_CIRCUMSTANCES',
  'AI_CONFIDENCE_FAILURE',
  'STALE_BALANCE_60D',
  'REPEATED_SMALL_PAYMENTS',
]);
export type EscalationFlagKind = z.infer<typeof EscalationFlagKindSchema>;

export const SentimentSchema = z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'DISTRESSED']);
export type Sentiment = z.infer<typeof SentimentSchema>;

export const InboundIntentSchema = z.enum([
  'PAYMENT_PROMISE',
  'PAYMENT_CONFIRMATION',
  'QUERY',
  'COMPLAINT',
  'REQUEST_FOR_INFO',
  'UNCLEAR',
]);
export type InboundIntent = z.infer<typeof InboundIntentSchema>;

export const SyncJobKindSchema = z.enum([
  'LWCA_INVOICE_POLL',
  'RENTANCY_TENANCY_REFRESH',
  'RENTANCY_CONTACT_REFRESH',
  'OUTLOOK_INBOUND_POLL',
  'CHASE_TICK',
]);
export type SyncJobKind = z.infer<typeof SyncJobKindSchema>;

export const SyncJobStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED']);
export type SyncJobStatus = z.infer<typeof SyncJobStatusSchema>;

export const CredentialStorageBackendSchema = z.enum(['LOCAL', 'SECRETS_MANAGER']);
export type CredentialStorageBackend = z.infer<typeof CredentialStorageBackendSchema>;
