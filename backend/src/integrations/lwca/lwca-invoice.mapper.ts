import type { ChargeStatus } from '@prisma/client';
import type { LwcaInvoice, LwcaInvoiceStatus } from './lwca-invoice.types';

/**
 * Upstream-derived fields for a Charge row. Case linkage (`caseId`) is
 * applied by the case-open flow in Phase 4 — the integration layer is not
 * concerned with which Case a charge belongs to, only with what the row
 * looks like coming out of LWCA.
 */
export interface LwcaChargeUpsert {
  organisationId: string;
  lwcaInvoiceId: string;
  dueDate: Date;
  invoiceDate: Date;
  grossAmountPence: bigint;
  lastKnownRemainAmountPence: bigint;
  lastKnownStatus: ChargeStatus;
  lastKnownPaymentCycleType: string | null;
  lastKnownType: string | null;
  lastKnownDescription: string | null;
  lastSyncedAt: Date;
  /** Reference id from LWCA — display only, not stored on Charge yet. */
  upstreamReferenceId: string | null;
}

/**
 * Property + tenancy denormalisations the case-open flow uses to write the
 * `Tenancy` row. LWCA's property block is canonical for property display;
 * Rentancy isn't fetched until the case opens (Phase 4.4).
 */
export interface LwcaTenancyHint {
  tenancyId: string;
  propertyId: string;
  propertyName: string | null;
  propertyAddress1: string | null;
  propertyAddress2: string | null;
}

export interface MappedLwcaInvoice {
  charge: LwcaChargeUpsert;
  tenancy: LwcaTenancyHint;
}

const ARREARS_STATUSES: ReadonlySet<LwcaInvoiceStatus> = new Set([
  'UNPAID',
  'PARTIALLY_PAID',
  'PARTIALLY_RECONCILED',
]);

/**
 * Per docs/integrations.md "Filtering rule on read", we re-apply our own
 * arrears rule rather than trusting `isArrear=true` on the LWCA side. A
 * future LWCA semantic change shouldn't silently surface as a new arrear in
 * our system.
 */
export class LwcaInvoiceMapper {
  /**
   * Filter + project a page of LWCA invoices into canonical shape.
   * Anything that isn't a real arrear (paid, deleted, recurring template,
   * zero remainder, missing due date) is dropped here — the case-open
   * service receives only the rows that should drive a chase.
   */
  static mapPage(invoices: LwcaInvoice[]): MappedLwcaInvoice[] {
    const now = new Date();
    const mapped: MappedLwcaInvoice[] = [];
    for (const inv of invoices) {
      if (!this.isArrearsCandidate(inv)) continue;
      const remain = toBigIntPence(inv.remainAmount);
      const gross = toBigIntPence(inv.grossAmount);
      if (remain <= 0n) continue;
      if (!inv.dueDate) continue;
      // Stage returns invoices without a tenancy link (unallocated or
      // ad-hoc charges). The chase pipeline is keyed on tenancies — skip.
      if (!inv.tenancyId) continue;
      mapped.push({
        charge: {
          organisationId: inv.organisationId,
          lwcaInvoiceId: inv.id,
          dueDate: parseDateOnly(inv.dueDate),
          invoiceDate: parseDateOnly(inv.invoiceDate),
          grossAmountPence: gross,
          lastKnownRemainAmountPence: remain,
          lastKnownStatus: inv.status,
          lastKnownPaymentCycleType: inv.paymentCycleType ?? null,
          lastKnownType: inv.type ?? null,
          lastKnownDescription: inv.description ?? null,
          lastSyncedAt: now,
          upstreamReferenceId: inv.referenceId ?? null,
        },
        tenancy: {
          tenancyId: inv.tenancyId,
          propertyId: inv.property?.propertyId ?? '',
          propertyName: inv.property?.propertyName ?? null,
          propertyAddress1: inv.property?.propertyAddress1 ?? null,
          propertyAddress2: inv.property?.propertyAddress2 ?? null,
        },
      });
    }
    return mapped;
  }

  private static isArrearsCandidate(inv: LwcaInvoice): boolean {
    if (inv.status === 'DELETED') return false;
    if (!ARREARS_STATUSES.has(inv.status)) return false;
    if ((inv.paymentCycleType ?? '').toUpperCase() === 'RECURRING') return false;
    // Arrears chasing is rent-only. The category lives on lineItems[i].type
    // — values like "Rent", "Security Deposit", "Council Tax". We tried
    // pushing this filter upstream via `?lineItemType=Rent` on the LWCA
    // query but stage silently ignores the param, so the only reliable
    // place to enforce it is here.
    if (!hasRentLineItem(inv)) return false;
    return true;
  }
}

function hasRentLineItem(inv: LwcaInvoice): boolean {
  for (const li of inv.lineItems ?? []) {
    if (li.type === 'Rent') return true;
  }
  return false;
}

function toBigIntPence(value: number | string): bigint {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.trunc(value) !== value) {
      throw new Error(`LWCA returned non-integer pence value: ${value}`);
    }
    return BigInt(value);
  }
  return BigInt(value);
}

function parseDateOnly(s: string): Date {
  // LWCA returns "YYYY-MM-DD"; treat as UTC midnight so working-day
  // arithmetic can re-project onto Europe/London at its boundary.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00Z`);
  return new Date(s);
}
