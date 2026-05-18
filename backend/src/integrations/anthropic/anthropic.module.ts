import Anthropic from '@anthropic-ai/sdk';
import { Module, type Provider } from '@nestjs/common';
import { ClockModule } from '../../common/clock/clock.module';
import { Clock } from '../../common/clock/clock.service';
import { AiModule } from '../../modules/ai/ai.module';
import { REDACTOR, type Redactor } from '../../modules/ai/redactor';
import { PrismaService } from '../prisma/prisma.service';
import {
  ANTHROPIC_CLIENT,
  NotImplementedAnthropicClient,
} from './anthropic-client';
import {
  ANTHROPIC_SDK,
  AnthropicHttpClient,
  type AnthropicSdkLike,
} from './anthropic-http-client';

const SDK_MAX_RETRIES = 3;

/**
 * Constructs the real Anthropic SDK. Lazy because we only want to
 * touch process.env.ANTHROPIC_API_KEY when ANTHROPIC_MODE=live; local
 * dev runs without a key and uses the throw-on-call placeholder.
 */
function buildSdk(): AnthropicSdkLike {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required when ANTHROPIC_MODE=live (set it in .env or use ANTHROPIC_MODE=disabled).',
    );
  }
  return new Anthropic({ apiKey, maxRetries: SDK_MAX_RETRIES }) as unknown as AnthropicSdkLike;
}

const anthropicSdkProvider: Provider = {
  provide: ANTHROPIC_SDK,
  useFactory: (): AnthropicSdkLike | null => {
    if ((process.env.ANTHROPIC_MODE ?? 'disabled').toLowerCase() !== 'live') {
      // Provide a stub so NestJS can still resolve the dependency graph
      // even when ANTHROPIC_MODE != live. The stub throws — but the
      // ANTHROPIC_CLIENT provider below routes to NotImplementedAnthropicClient
      // in that mode, so the stub is never called by production code.
      return {
        messages: {
          create: () => {
            throw new Error(
              'Anthropic SDK not initialised (ANTHROPIC_MODE != "live").',
            );
          },
        },
      };
    }
    return buildSdk();
  },
};

const anthropicClientProvider: Provider = {
  provide: ANTHROPIC_CLIENT,
  useFactory: (
    prisma: PrismaService,
    clock: Clock,
    sdk: AnthropicSdkLike,
    redactor: Redactor,
  ) => {
    if ((process.env.ANTHROPIC_MODE ?? 'disabled').toLowerCase() !== 'live') {
      return new NotImplementedAnthropicClient();
    }
    return new AnthropicHttpClient(prisma, clock, sdk, redactor);
  },
  inject: [PrismaService, Clock, ANTHROPIC_SDK, REDACTOR],
};

@Module({
  imports: [AiModule, ClockModule],
  providers: [anthropicSdkProvider, anthropicClientProvider],
  exports: [anthropicClientProvider],
})
export class AnthropicModule {}
