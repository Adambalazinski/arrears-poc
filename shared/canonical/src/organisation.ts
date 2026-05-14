import { z } from 'zod';
import { CredentialStorageBackendSchema } from './enums';
import { IsoDateTimeSchema, JsonValueSchema, OrganisationIdSchema, UuidSchema } from './common';

export const OrganisationSchema = z.object({
  id: OrganisationIdSchema,
  name: z.string(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Organisation = z.infer<typeof OrganisationSchema>;

export const OrganisationConfigSchema = z.object({
  organisationId: OrganisationIdSchema,
  chaseDayFirst: z.number().int().positive(),
  chaseDaySecond: z.number().int().positive(),
  chaseDayThird: z.number().int().positive(),
  chaseDayExecNotify: z.number().int().positive(),
  workingDayCalendar: z.string(),
  s8RentMonthsThreshold: z.number().int().positive(),
  s8WeeksThreshold: z.number().int().positive(),
  pollingIntervalMinutes: z.number().int().positive(),
  autoSendEnabled: z.boolean(),
  aiClassificationModel: z.string(),
  aiDraftModel: z.string(),
  aiConfidenceThreshold: z.number().min(0).max(1),
  templateWd3Tenant: z.string(),
  templateWd5Tenant: z.string(),
  templateWd8Tenant: z.string(),
  templateWd14Tenant: z.string(),
  templateBrokenPromise: z.string(),
  hardTriggerOverrides: JsonValueSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type OrganisationConfig = z.infer<typeof OrganisationConfigSchema>;

// Bytes columns in Prisma surface as Uint8Array at runtime. We don't typically pass
// credentials through Zod schemas at API boundaries (they live behind the credential
// store interface) — this schema is for completeness and parity-check use only.
export const OrganisationCredentialSchema = z.object({
  organisationId: OrganisationIdSchema,
  storageBackend: CredentialStorageBackendSchema,
  accessTokenEncrypted: z.instanceof(Uint8Array).nullable(),
  refreshTokenEncrypted: z.instanceof(Uint8Array).nullable(),
  secretArn: z.string().nullable(),
  accessTokenExpiresAt: IsoDateTimeSchema.nullable(),
  refreshTokenExpiresAt: IsoDateTimeSchema.nullable(),
  createdByUserId: UuidSchema,
  createdAt: IsoDateTimeSchema,
  rotatedByUserId: UuidSchema.nullable(),
  rotatedAt: IsoDateTimeSchema.nullable(),
  lastUsedAt: IsoDateTimeSchema.nullable(),
});
export type OrganisationCredential = z.infer<typeof OrganisationCredentialSchema>;
