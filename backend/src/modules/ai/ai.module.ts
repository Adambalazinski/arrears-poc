import { Module, type Provider } from '@nestjs/common';
import { PreFilterService } from './pre-filter.service';
import { DefaultRedactor, REDACTOR } from './redactor';

const redactorProvider: Provider = {
  provide: REDACTOR,
  useClass: DefaultRedactor,
};

/**
 * AI-adjacent services. Currently hosts the deterministic pre-filter
 * (7.2) and the Redactor seam (7.4); Phase 7.5 lands the real Redactor.
 * AnthropicClient lives in integrations/anthropic/ (factory-provided
 * there to keep the SDK-loading branch tidy).
 */
@Module({
  providers: [PreFilterService, redactorProvider],
  exports: [PreFilterService, redactorProvider],
})
export class AiModule {}
