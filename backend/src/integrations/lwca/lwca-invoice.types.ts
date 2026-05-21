// Upstream DTO shapes, as returned by LWCA's /v1/api/invoice endpoint.
// Mirrors `InvoiceApiResponse` in loftyworks-accounting. Fields the mapper
// doesn't read are typed as `unknown` (and the schema below ignores them) so
// any new LWCA fields land in canonical only when explicitly mapped — see
// CLAUDE.md "adding a field to canonical without a mapper update is a build
// error".

import { z } from 'zod';

export const LwcaInvoiceStatusSchema = z.enum([
  'UNPAID',
  'PARTIALLY_PAID',
  'PARTIALLY_RECONCILED',
  'PAID',
  'RECONCILED',
  'DELETED',
  'PAYMENT_PROCESSING',
]);
export type LwcaInvoiceStatus = z.infer<typeof LwcaInvoiceStatusSchema>;

export const LwcaInvoicePropertySchema = z.object({
  propertyId: z.string(),
  propertyName: z.string().nullable().optional(),
  propertyAddress1: z.string().nullable().optional(),
  propertyAddress2: z.string().nullable().optional(),
});
export type LwcaInvoiceProperty = z.infer<typeof LwcaInvoicePropertySchema>;

export const LwcaInvoiceSchema = z.object({
  id: z.string(),
  organisationId: z.string(),
  referenceId: z.string().nullable().optional(),
  // LWCA returns these as numeric BigIntegers — JSON.parse gives us number.
  // We accept either number or string and coerce to bigint at the mapper.
  grossAmount: z.union([z.number(), z.string()]),
  remainAmount: z.union([z.number(), z.string()]),
  dueDate: z.string().nullable(),
  invoiceDate: z.string(),
  status: LwcaInvoiceStatusSchema,
  paymentCycleType: z.string().nullable().optional(),
  // Stage returns null for unallocated/ad-hoc invoices; the mapper drops
  // them because the chase pipeline is keyed on tenancies.
  tenancyId: z.string().nullable(),
  type: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  payeeType: z.string().optional(),
  property: LwcaInvoicePropertySchema.optional(),
  payer: z
    .object({
      payerId: z.string().optional(),
      firstName: z.string().nullable().optional(),
      lastName: z.string().nullable().optional(),
    })
    .optional(),
});
export type LwcaInvoice = z.infer<typeof LwcaInvoiceSchema>;

// Spring Data `Page<T>` envelope.
export const LwcaPagedInvoicesSchema = z.object({
  content: z.array(LwcaInvoiceSchema),
  totalElements: z.number().optional(),
  totalPages: z.number().optional(),
  size: z.number().optional(),
  number: z.number().optional(),
});
export type LwcaPagedInvoices = z.infer<typeof LwcaPagedInvoicesSchema>;
