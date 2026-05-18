import { Module } from '@nestjs/common';
import { PreFilterService } from './pre-filter.service';

/**
 * AI-adjacent services. Phase 7.2 ships only the deterministic
 * pre-filter (no Anthropic dependency). Phase 7.4 adds AnthropicClient
 * + Redactor here.
 */
@Module({
  providers: [PreFilterService],
  exports: [PreFilterService],
})
export class AiModule {}
