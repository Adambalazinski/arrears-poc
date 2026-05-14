import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  LWCA_INVOICE_CLIENT,
  type LwcaInvoiceClient,
  type LwcaProbeOutcome,
} from '../../integrations/lwca/lwca-invoice.client';
import {
  RENTANCY_CLIENT,
  type RentancyProbeOutcome,
  type RentancyTenancyClient,
} from '../../integrations/rentancy/rentancy.client';

export type ProbeUpstreamStatus = 'OK' | 'FAILED';

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
 * Per docs/integrations.md §5 "Probe contract for credential setup".
 * Fires both probes concurrently with Promise.allSettled so one upstream
 * being down doesn't mask the other's status.
 */
@Injectable()
export class ProbeService {
  private readonly logger = new Logger(ProbeService.name);

  constructor(
    @Inject(LWCA_INVOICE_CLIENT) private readonly lwca: LwcaInvoiceClient,
    @Inject(RENTANCY_CLIENT) private readonly rentancy: RentancyTenancyClient,
  ) {}

  async probe(organisationId: string, accessToken: string): Promise<ProbeResult> {
    const [lwcaResult, rentancyResult] = await Promise.allSettled([
      this.lwca.probe(organisationId, accessToken),
      this.rentancy.probe(organisationId, accessToken),
    ]);
    const lwca = toUpstream(lwcaResult);
    const rentancy = toUpstream(rentancyResult);
    const okCount = (lwca.status === 'OK' ? 1 : 0) + (rentancy.status === 'OK' ? 1 : 0);
    const overall: ProbeResult['overall'] =
      okCount === 2 ? 'OK' : okCount === 1 ? 'PARTIAL' : 'FAILED';
    return { lwca, rentancy, overall };
  }
}

function toUpstream(
  settled: PromiseSettledResult<LwcaProbeOutcome | RentancyProbeOutcome>,
): ProbeUpstreamResult {
  if (settled.status === 'fulfilled') {
    return {
      status: settled.value.ok ? 'OK' : 'FAILED',
      message: settled.value.message,
      latencyMs: settled.value.latencyMs,
    };
  }
  const err = settled.reason;
  return {
    status: 'FAILED',
    message: err instanceof Error ? err.message : String(err),
    latencyMs: 0,
  };
}
