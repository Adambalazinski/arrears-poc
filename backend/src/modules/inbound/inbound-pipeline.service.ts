import { Injectable, Logger } from '@nestjs/common';

/**
 * Seam for the inbound pipeline (pre-filter → classify → draft).
 *
 * Phase 7.1 (this step): no-op. The poll job persists the Communication
 * and emits the COMMUNICATION_RECEIVED timeline event; this method is
 * invoked at the point the next phases will plug in.
 *
 * Phase 7.2 will run the deterministic hard-trigger pre-filter here.
 * Phase 7.4–7.7 will add Anthropic classification and Sonnet drafting.
 */
@Injectable()
export class InboundPipelineService {
  private readonly logger = new Logger(InboundPipelineService.name);

  async handle(communicationId: string): Promise<void> {
    this.logger.debug(
      `inbound-pipeline: stub no-op for communication ${communicationId}`,
    );
  }
}
