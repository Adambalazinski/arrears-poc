import { z } from 'zod';

export const PenceSchema = z.bigint().nonnegative();
export type Pence = z.infer<typeof PenceSchema>;

export const UuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof UuidSchema>;

export const OrganisationIdSchema = z.string().min(1);
export type OrganisationId = z.infer<typeof OrganisationIdSchema>;

export const IsoDateTimeSchema = z.coerce.date();

export const JsonValueSchema: z.ZodType<unknown> = z.unknown();
