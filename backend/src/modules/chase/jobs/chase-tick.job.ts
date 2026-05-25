import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChaseTickService } from '../chase-tick.service';
import { DigestService } from '../digest/digest.service';

@Injectable()
export class ChaseTickJob {
  private readonly logger = new Logger(ChaseTickJob.name);

  constructor(
    private readonly tick: ChaseTickService,
    private readonly digest: DigestService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async run(): Promise<void> {
    const start = Date.now();
    try {
      const r = await this.tick.runTick();
      this.logger.log(
        `chase-tick scanned=${r.scanned} created=${r.entriesCreated} skipped=${r.entriesSkipped} stagesAdvanced=${r.stagesAdvanced} elapsedMs=${Date.now() - start}`,
      );
      // Immediately run the digest so any entries we just created with
      // dueAt in the past don't have to wait until tomorrow's 09:00
      // London cron. The digest's own filters (firedAt IS NULL AND
      // dueAt <= now) make it a no-op when nothing is eligible.
      const d = await this.digest.runDigest();
      if (d.casesEvaluated > 0 || d.digestsCreated > 0) {
        this.logger.log(
          `chase-tick: post-tick digest evaluated=${d.casesEvaluated} drafts=${d.digestsCreated} entriesFired=${d.entriesFired}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `chase-tick failed after ${Date.now() - start}ms — ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
