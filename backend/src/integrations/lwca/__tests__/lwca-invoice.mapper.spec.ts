import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LwcaInvoiceMapper } from '../lwca-invoice.mapper';
import { LwcaPagedInvoicesSchema, type LwcaInvoice } from '../lwca-invoice.types';

const FIXTURE = path.resolve(__dirname, '../../../../../fixtures/lwca/invoices-list.json');

async function loadFixture(): Promise<LwcaInvoice[]> {
  const raw = await fs.readFile(FIXTURE, 'utf-8');
  return LwcaPagedInvoicesSchema.parse(JSON.parse(raw)).content;
}

describe('LwcaInvoiceMapper.mapPage (fixture)', () => {
  it('drops DELETED, RECURRING, PAID, zero-remain, and non-Rent rows', async () => {
    const invoices = await loadFixture();
    const mapped = LwcaInvoiceMapper.mapPage(invoices);
    expect(mapped.map((m) => m.charge.lwcaInvoiceId).sort()).toEqual([
      'lwca-inv-0001',
      'lwca-inv-0002',
      'lwca-inv-0003',
      'lwca-inv-0007',
      'lwca-inv-0008',
      'lwca-inv-0009',
      'lwca-inv-0010',
    ]);
    // 0011 is a Security Deposit invoice — must be filtered out even though
    // it's UNPAID/OUTBOUND, because the arrears pipeline is rent-only.
    expect(mapped.find((m) => m.charge.lwcaInvoiceId === 'lwca-inv-0011')).toBeUndefined();
  });

  it('projects amounts to bigint pence and preserves status', async () => {
    const invoices = await loadFixture();
    const mapped = LwcaInvoiceMapper.mapPage(invoices);
    const partial = mapped.find((m) => m.charge.lwcaInvoiceId === 'lwca-inv-0002')!;
    expect(typeof partial.charge.grossAmountPence).toBe('bigint');
    expect(partial.charge.grossAmountPence).toBe(120000n);
    expect(partial.charge.lastKnownRemainAmountPence).toBe(80000n);
    expect(partial.charge.lastKnownStatus).toBe('PARTIALLY_PAID');
    expect(partial.charge.lastKnownPaymentCycleType).toBe('MONTHLY');
  });

  it('parses dueDate / invoiceDate as UTC midnight', async () => {
    const invoices = await loadFixture();
    const mapped = LwcaInvoiceMapper.mapPage(invoices);
    const first = mapped.find((m) => m.charge.lwcaInvoiceId === 'lwca-inv-0001')!;
    expect(first.charge.dueDate.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(first.charge.invoiceDate.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('lifts the property block into a TenancyHint', async () => {
    const invoices = await loadFixture();
    const mapped = LwcaInvoiceMapper.mapPage(invoices);
    const first = mapped.find((m) => m.charge.lwcaInvoiceId === 'lwca-inv-0001')!;
    expect(first.tenancy).toEqual({
      tenancyId: 'tenancy-abc-001',
      propertyId: 'prop-001',
      propertyName: 'Flat 2',
      propertyAddress1: '12 High Street',
      propertyAddress2: 'London W1 1AA',
    });
  });

  it('drops rows with null dueDate', () => {
    const bad: LwcaInvoice = {
      id: 'x',
      organisationId: 'o',
      grossAmount: 100,
      remainAmount: 100,
      dueDate: null,
      invoiceDate: '2026-04-01',
      status: 'UNPAID',
      paymentCycleType: 'MONTHLY',
      tenancyId: 't',
      lineItems: [{ type: 'Rent' }],
    };
    expect(LwcaInvoiceMapper.mapPage([bad])).toEqual([]);
  });

  it('accepts string pence amounts (BigInteger over JSON)', () => {
    const inv: LwcaInvoice = {
      id: 'x',
      organisationId: 'o',
      grossAmount: '12345678901234',
      remainAmount: '1000',
      dueDate: '2026-04-01',
      invoiceDate: '2026-03-15',
      status: 'UNPAID',
      paymentCycleType: 'MONTHLY',
      tenancyId: 't',
      lineItems: [{ type: 'Rent' }],
    };
    const [m] = LwcaInvoiceMapper.mapPage([inv]);
    expect(m!.charge.grossAmountPence).toBe(12345678901234n);
    expect(m!.charge.lastKnownRemainAmountPence).toBe(1000n);
  });

  it('drops invoices whose line items contain no Rent entry', () => {
    const inv: LwcaInvoice = {
      id: 'deposit-only',
      organisationId: 'o',
      grossAmount: 50000,
      remainAmount: 50000,
      dueDate: '2026-04-01',
      invoiceDate: '2026-03-15',
      status: 'UNPAID',
      paymentCycleType: 'SINGLE',
      tenancyId: 't',
      lineItems: [{ type: 'Security Deposit' }, { type: 'Council Tax' }],
    };
    expect(LwcaInvoiceMapper.mapPage([inv])).toEqual([]);
  });

  it('keeps invoices with at least one Rent line item alongside other categories', () => {
    const inv: LwcaInvoice = {
      id: 'mixed-with-rent',
      organisationId: 'o',
      grossAmount: 150000,
      remainAmount: 150000,
      dueDate: '2026-04-01',
      invoiceDate: '2026-03-15',
      status: 'UNPAID',
      paymentCycleType: 'MONTHLY',
      tenancyId: 't',
      lineItems: [{ type: 'Council Tax' }, { type: 'Rent' }],
    };
    const [m] = LwcaInvoiceMapper.mapPage([inv]);
    expect(m?.charge.lwcaInvoiceId).toBe('mixed-with-rent');
  });

  it('drops invoices that are missing lineItems entirely (defensive)', () => {
    const inv: LwcaInvoice = {
      id: 'no-items',
      organisationId: 'o',
      grossAmount: 100,
      remainAmount: 100,
      dueDate: '2026-04-01',
      invoiceDate: '2026-03-15',
      status: 'UNPAID',
      paymentCycleType: 'MONTHLY',
      tenancyId: 't',
    };
    expect(LwcaInvoiceMapper.mapPage([inv])).toEqual([]);
  });
});
