import { Module } from '@nestjs/common';
import { ClockModule } from '../../common/clock/clock.module';
import { AnthropicModule } from '../../integrations/anthropic/anthropic.module';
import { OutlookModule } from '../../integrations/outlook/outlook.module';
import { AiModule } from '../ai/ai.module';
import { CasesModule } from '../cases/cases.module';
import { InboundCursorService } from './inbound-cursor.service';
import { InboundPipelineService } from './inbound-pipeline.service';
import { InboundSenderMatcher } from './inbound-sender-matcher.service';
import { OutlookInboundPollJob } from './jobs/outlook-inbound-poll.job';

@Module({
  imports: [ClockModule, OutlookModule, AiModule, AnthropicModule, CasesModule],
  providers: [
    InboundCursorService,
    InboundSenderMatcher,
    InboundPipelineService,
    OutlookInboundPollJob,
  ],
  exports: [
    InboundCursorService,
    InboundSenderMatcher,
    InboundPipelineService,
    OutlookInboundPollJob,
  ],
})
export class InboundModule {}
