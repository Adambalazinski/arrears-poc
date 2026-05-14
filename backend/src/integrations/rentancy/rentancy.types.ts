import { z } from 'zod';

export const RentancyTenancySchema = z.object({
  id: z.string(),
  tenancyPropertyId: z.string().nullable().optional(),
  status: z.string(),
  reference: z.string().nullable().optional(),
  paymentDay: z.number().int().min(1).max(31).nullable().optional(),
  // Both shapes appear in the wild — see docs/integrations.md.
  tenants: z.array(z.string()).nullable().optional(),
  guarantorIds: z.array(z.string()).nullable().optional(),
  guarantors: z.array(z.string()).nullable().optional(),
  askingPrice: z.union([z.number(), z.string()]).nullable().optional(),
  agreedPrice: z.union([z.number(), z.string()]).nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
});
export type RentancyTenancy = z.infer<typeof RentancyTenancySchema>;

export const RentancyEmailSchema = z.object({
  type: z.string().nullable().optional(),
  email: z.string(),
});

export const RentancyPhoneSchema = z.object({
  type: z.string().nullable().optional(),
  phone: z.string(),
});

export const RentancyContactSchema = z.object({
  id: z.string(),
  fname: z.string().nullable().optional(),
  sname: z.string().nullable().optional(),
  companyName: z.string().nullable().optional(),
  emails: z.array(RentancyEmailSchema).nullable().optional(),
  phones: z.array(RentancyPhoneSchema).nullable().optional(),
});
export type RentancyContact = z.infer<typeof RentancyContactSchema>;
