import type { TenancyStatus } from '@prisma/client';
import type { RentancyContact, RentancyTenancy } from './rentancy.types';

export interface RentancyTenancyUpsert {
  tenancyId: string;
  propertyId: string;
  status: TenancyStatus;
  reference: string | null;
  rentDayOfMonth: number | null;
  rentAmountPence: bigint | null;
  tenantContactIds: string[];
  guarantorContactIds: string[];
}

export interface RentancyContactUpsert {
  contactId: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  primaryEmail: string | null;
  emailsJson: Array<{ type: string | null; email: string }>;
  phonesJson: Array<{ type: string | null; phone: string }>;
}

const STATUS_MAP: Record<string, TenancyStatus> = {
  ACTIVE: 'ACTIVE',
  ENDED: 'ENDED',
  TERMINATED: 'ENDED',
  CLOSED: 'ENDED',
};

export class RentancyMapper {
  static tenancy(t: RentancyTenancy): RentancyTenancyUpsert {
    const status = STATUS_MAP[t.status.toUpperCase()] ?? 'UNKNOWN';
    const tenants = (t.tenants ?? []).filter((id): id is string => typeof id === 'string');
    const rawGuarantors = t.guarantorIds ?? t.guarantors ?? [];
    const guarantors = Array.from(
      new Set(rawGuarantors.filter((id): id is string => typeof id === 'string')),
    );
    return {
      tenancyId: t.id,
      propertyId: t.tenancyPropertyId ?? '',
      status,
      reference: t.reference ?? null,
      rentDayOfMonth: t.paymentDay ?? null,
      rentAmountPence: t.agreedPrice != null ? toBigIntPence(t.agreedPrice) : null,
      tenantContactIds: tenants,
      guarantorContactIds: guarantors,
    };
  }

  static contact(c: RentancyContact): RentancyContactUpsert {
    const emails = (c.emails ?? []).map((e) => ({ type: e.type ?? null, email: e.email }));
    const phones = (c.phones ?? []).map((p) => ({ type: p.type ?? null, phone: p.phone }));
    const primaryEmail = emails[0]?.email ?? null;
    return {
      contactId: c.id,
      firstName: c.fname ?? null,
      lastName: c.sname ?? null,
      companyName: c.companyName ?? null,
      primaryEmail,
      emailsJson: emails,
      phonesJson: phones,
    };
  }
}

function toBigIntPence(value: number | string): bigint {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.trunc(value) !== value) {
      throw new Error(`Rentancy returned non-integer pence value: ${value}`);
    }
    return BigInt(value);
  }
  return BigInt(value);
}
