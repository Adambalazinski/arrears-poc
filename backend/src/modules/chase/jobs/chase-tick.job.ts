import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChaseTickService } from '../chase-tick.service';

@Injectable()
export class ChaseTickJob {
  private readonly logger = new Logger(ChaseTickJob.name);

  constructor(private readonly tick: ChaseTickService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async run(): Promise<void> {
    const start = Date.now();
    try {
      const r = await this.tick.runTick();
      this.logger.log(
        `chase-tick scanned=${r.scanned} created=${r.entriesCreated} skipped=${r.entriesSkipped} stagesAdvanced=${r.stagesAdvanced} elapsedMs=${Date.now() - start}`,
      );
    } catch (err) {
      this.logger.error(
        `chase-tick failed after ${Date.now() - start}ms — ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
