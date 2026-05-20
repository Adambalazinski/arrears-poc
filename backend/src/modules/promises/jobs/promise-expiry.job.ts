import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PromiseStatus } from '@prisma/client';
import { Clock } from '../../../common/clock/clock.service';
import { PrismaService } from '../../../integrations/prisma/prisma.service';
import { PromisesService } from '../promises.service';

/**
 * Daily expiry scan: finds ACTIVE promises whose promiseDate is in the
 * past and asks PromisesService.markBroken to transition them. The
 * service itself owns the cascade (mark BROKEN + emit event + draft
 * broken-promise communication + queue for approval).
 *
 * Idempotent: a second tick on the same day sees nothing to do.
 */
@Injectable()
export class PromiseExpiryJob {
  private readonly logger = new Logger(PromiseExpiryJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly promises: PromisesService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async run(): Promise<void> {
    const start = Date.now();
    const r = await this.runOnce();
    this.logger.log(
      `promise-expiry checked=${r.checked} broken=${r.broken} elapsedMs=${Date.now() - start}`,
    );
  }

  /** Public for dev tools and tests. */
  async runOnce(): Promise<{ checked: number; broken: number }> {
    const now = this.clock.now();
    const expired = await this.prisma.promise.findMany({
      where: {
        status: PromiseStatus.ACTIVE,
        promiseDate: { lt: now },
      },
      select: { id: true },
    });
    let broken = 0;
    for (const p of expired) {
      try {
        await this.promises.markBroken(p.id);
        broken++;
      } catch (err) {
        this.logger.warn(
          `promise-expiry: ${p.id} failed — ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return { checked: expired.length, broken };
  }
}
