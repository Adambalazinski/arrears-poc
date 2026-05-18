import { Module } from '@nestjs/common';
import { ClockModule } from '../../common/clock/clock.module';
import { OutlookModule } from '../../integrations/outlook/outlook.module';
import { InboundCursorService } from './inbound-cursor.service';
import { InboundPipelineService } from './inbound-pipeline.service';
import { InboundSenderMatcher } from './inbound-sender-matcher.service';
import { OutlookInboundPollJob } from './jobs/outlook-inbound-poll.job';

@Module({
  imports: [ClockModule, OutlookModule],
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
