import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DigestService } from '../digest/digest.service';

@Injectable()
export class DailyDigestJob {
  private readonly logger = new Logger(DailyDigestJob.name);

  constructor(private readonly digest: DigestService) {}

  /** 09:00 Europe/London weekdays + weekends; the chase tick decides
   *  whether weekends count by anchoring dueAt to working-day arithmetic. */
  @Cron('0 9 * * *', { timeZone: 'Europe/London' })
  async run(): Promise<void> {
    const start = Date.now();
    try {
      const r = await this.digest.runDigest();
      this.logger.log(
        `daily-digest evaluated=${r.casesEvaluated} drafts=${r.digestsCreated} entriesFired=${r.entriesFired} elapsedMs=${Date.now() - start}`,
      );
    } catch (err) {
      this.logger.error(
        `daily-digest failed after ${Date.now() - start}ms — ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
