import type { RentancyContactUpsert, RentancyTenancyUpsert } from './rentancy.mapper';

export interface RentancyProbeOutcome {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export interface RentancyTenancyClient {
  getTenancy(organisationId: string, tenancyId: string): Promise<RentancyTenancyUpsert>;
  getContact(organisationId: string, contactId: string): Promise<RentancyContactUpsert>;
  probe(organisationId: string, accessToken: string): Promise<RentancyProbeOutcome>;
}

export const RENTANCY_CLIENT = Symbol('RENTANCY_CLIENT');

export class RentancyNotFoundError extends Error {
  constructor(public readonly kind: 'tenancy' | 'contact', public readonly id: string) {
    super(`Rentancy ${kind} ${id} not found`);
    this.name = 'RentancyNotFoundError';
  }
}
