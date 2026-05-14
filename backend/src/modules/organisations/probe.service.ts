import { Injectable } from '@nestjs/common';

export type ProbeUpstreamStatus = 'OK' | 'FAILED' | 'NOT_IMPLEMENTED';

export interface ProbeUpstreamResult {
  status: ProbeUpstreamStatus;
  message: string;
  latencyMs: number;
}

export interface ProbeResult {
  overall: 'OK' | 'PARTIAL' | 'FAILED';
  lwca: ProbeUpstreamResult;
  rentancy: ProbeUpstreamResult;
}

/**
 * Stub probe. Phase 3 swaps this for real LwcaInvoiceClient.probe and
 * RentancyTenancyClient.probe calls. Returning FAILED now lets the
 * "save anyway" flow in 2.2 be exercised end-to-end before integrations land.
 */
@Injectable()
export class ProbeService {
  async probe(_organisationId: string, _accessToken: string): Promise<ProbeResult> {
    const lwca: ProbeUpstreamResult = {
      status: 'NOT_IMPLEMENTED',
      message: 'LWCA invoice client not yet wired (Phase 3.1)',
      latencyMs: 0,
    };
    const rentancy: ProbeUpstreamResult = {
      status: 'NOT_IMPLEMENTED',
      message: 'Rentancy tenancy client not yet wired (Phase 3.2)',
      latencyMs: 0,
    };
    return { overall: 'FAILED', lwca, rentancy };
  }
}
