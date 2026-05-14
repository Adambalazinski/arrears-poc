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
  it('drops DELETED, RECURRING, PAID, and zero-remain rows', async () => {
    const invoices = await loadFixture();
    const mapped = LwcaInvoiceMapper.mapPage(invoices);
    expect(mapped.map((m) => m.charge.lwcaInvoiceId).sort()).toEqual([
      'lwca-inv-0001',
      'lwca-inv-0002',
      'lwca-inv-0003',
    ]);
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
    };
    const [m] = LwcaInvoiceMapper.mapPage([inv]);
    expect(m!.charge.grossAmountPence).toBe(12345678901234n);
    expect(m!.charge.lastKnownRemainAmountPence).toBe(1000n);
  });
});
