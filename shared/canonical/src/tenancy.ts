import { z } from 'zod';
import { ContactRoleSchema, TenancyStatusSchema } from './enums';
import {
  IsoDateTimeSchema,
  JsonValueSchema,
  OrganisationIdSchema,
  PenceSchema,
  UuidSchema,
} from './common';

export const TenancySchema = z.object({
  id: UuidSchema,
  organisationId: OrganisationIdSchema,
  propertyId: z.string(),
  propertyName: z.string().nullable(),
  propertyAddress1: z.string().nullable(),
  propertyAddress2: z.string().nullable(),
  reference: z.string().nullable(),
  rentDayOfMonth: z.number().int().min(1).max(31).nullable(),
  rentAmountPence: PenceSchema.nullable(),
  status: TenancyStatusSchema,
  lastSyncedAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Tenancy = z.infer<typeof TenancySchema>;

export const ContactSchema = z.object({
  id: UuidSchema,
  organisationId: OrganisationIdSchema,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  companyName: z.string().nullable(),
  primaryEmail: z.string().email().nullable(),
  emailsJson: JsonValueSchema,
  phonesJson: JsonValueSchema,
  lastSyncedAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Contact = z.infer<typeof ContactSchema>;

export const TenancyContactSchema = z.object({
  tenancyId: UuidSchema,
  contactId: UuidSchema,
  role: ContactRoleSchema,
});
export type TenancyContact = z.infer<typeof TenancyContactSchema>;
