import { z } from 'zod';

export const CreateOrganisationSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
});
export type CreateOrganisationDto = z.infer<typeof CreateOrganisationSchema>;

export const UpdateOrganisationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
});
export type UpdateOrganisationDto = z.infer<typeof UpdateOrganisationSchema>;

export const UpdateOrganisationConfigSchema = z
  .object({
    chaseDayFirst: z.number().int().positive().max(60),
    chaseDaySecond: z.number().int().positive().max(60),
    chaseDayThird: z.number().int().positive().max(60),
    chaseDayExecNotify: z.number().int().positive().max(60),
    workingDayCalendar: z.string().min(1),
    s8RentMonthsThreshold: z.number().int().positive().max(12),
    s8WeeksThreshold: z.number().int().positive().max(52),
    pollingIntervalMinutes: z.number().int().min(1).max(1440),
    autoSendEnabled: z.boolean(),
    aiClassificationModel: z.string().min(1),
    aiDraftModel: z.string().min(1),
    aiConfidenceThreshold: z.number().min(0).max(1),
    templateWd3Tenant: z.string().min(1),
    templateWd5Tenant: z.string().min(1),
    templateWd8Tenant: z.string().min(1),
    templateWd14Tenant: z.string().min(1),
    templateBrokenPromise: z.string().min(1),
    hardTriggerOverrides: z.unknown().nullable(),
  })
  .partial();
export type UpdateOrganisationConfigDto = z.infer<typeof UpdateOrganisationConfigSchema>;

export const StoreCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.string().datetime().optional(),
  refreshTokenExpiresAt: z.string().datetime().optional(),
  allowFailedProbe: z.boolean().optional().default(false),
});
export type StoreCredentialsDto = z.infer<typeof StoreCredentialsSchema>;

export const ProbeCredentialsSchema = z.object({
  accessToken: z.string().min(1),
});
export type ProbeCredentialsDto = z.infer<typeof ProbeCredentialsSchema>;
