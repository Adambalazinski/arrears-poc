import { Module, type Provider } from '@nestjs/common';
import {
  ANTHROPIC_CLIENT,
  NotImplementedAnthropicClient,
} from './anthropic-client';

const anthropicClientProvider: Provider = {
  provide: ANTHROPIC_CLIENT,
  // Phase 7.3: seam only. Phase 7.4 swaps this for the real
  // @anthropic-ai/sdk-backed implementation.
  useClass: NotImplementedAnthropicClient,
};

@Module({
  providers: [anthropicClientProvider],
  exports: [anthropicClientProvider],
})
export class AnthropicModule {}
