import type { MappedLwcaInvoice } from './lwca-invoice.mapper';
import type { LwcaInvoice } from './lwca-invoice.types';

export interface LwcaProbeOutcome {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export interface LwcaInvoiceClient {
  listArrears(organisationId: string): Promise<MappedLwcaInvoice[]>;
  /**
   * Same fetch as `listArrears` but returns the raw upstream rows (line
   * items included), with no mapper filtering. Used by the dev-tools
   * purge endpoint to identify Charge rows whose underlying invoice is
   * non-Rent and should be removed from the DB.
   */
  listAllRaw(organisationId: string): Promise<LwcaInvoice[]>;
  /**
   * Fetch one invoice by id. Used to refresh charges that fell off the
   * arrears list (typically because they got paid) — the list query
   * filters by `statuses=UNPAID,PARTIALLY_PAID,PARTIALLY_RECONCILED`, so
   * a paid invoice never comes back through `listArrears` and our local
   * state would otherwise stay UNPAID forever.
   *
   * Returns `null` when the upstream invoice no longer exists (404).
   */
  getInvoice(organisationId: string, invoiceId: string): Promise<LwcaInvoice | null>;
  /**
   * Validate-on-save: calls /v1/api/invoice?size=1 against stage using the
   * caller-supplied access token (the credential row may not exist yet).
   */
  probe(organisationId: string, accessToken: string): Promise<LwcaProbeOutcome>;
}

export const LWCA_INVOICE_CLIENT = Symbol('LWCA_INVOICE_CLIENT');
