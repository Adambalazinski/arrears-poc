import type { MappedLwcaInvoice } from './lwca-invoice.mapper';

export interface LwcaProbeOutcome {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export interface LwcaInvoiceClient {
  listArrears(organisationId: string): Promise<MappedLwcaInvoice[]>;
  /**
   * Validate-on-save: calls /v1/api/invoice?size=1 against stage using the
   * caller-supplied access token (the credential row may not exist yet).
   */
  probe(organisationId: string, accessToken: string): Promise<LwcaProbeOutcome>;
}

export const LWCA_INVOICE_CLIENT = Symbol('LWCA_INVOICE_CLIENT');
