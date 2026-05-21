import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Clock } from '../../common/clock/clock.service';
import { WorkingDayService } from '../../common/working-day/working-day.service';
import { ZodBody } from '../../common/zod/zod-validation.pipe';
import { AuthGuard } from '../auth/auth.guard';
import { LwcaInvoicePollJob } from '../cases/jobs/lwca-invoice-poll.job';
import { ChaseTickService } from '../chase/chase-tick.service';
import { DigestService } from '../chase/digest/digest.service';
import { todayAt9LondonAsUtc } from '../chase/london-clock';
import { PromiseExpiryJob } from '../promises/jobs/promise-expiry.job';
import { PurgeNonRentService } from './purge-non-rent.service';
import { SeedFixtureEmailsService } from './seed-fixture-emails.service';

const AdvanceClockSchema = z.object({
  workingDays: z.number().int().min(1).max(60),
});

const SeedFixtureEmailsSchema = z.object({
  fixture: z.string().regex(/\.eml$/).optional(),
});

@Controller('dev')
@UseGuards(AuthGuard)
export class DevToolsController {
  constructor(
    private readonly clock: Clock,
    private readonly workingDay: WorkingDayService,
    private readonly chaseTick: ChaseTickService,
    private readonly digest: DigestService,
    private readonly seedFixtures: SeedFixtureEmailsService,
    private readonly lwcaPoll: LwcaInvoicePollJob,
    private readonly promiseExpiry: PromiseExpiryJob,
    private readonly purgeNonRent: PurgeNonRentService,
  ) {}

  /**
   * Run the LWCA invoice poll inline for one organisation — the local-dev
   * shortcut for the scheduled @Cron in LwcaInvoicePollJob. Useful for
   * the demo and for tightening the seed → review-queue loop.
   */
  @Post('force-sync/:orgId')
  @HttpCode(200)
  async forceSync(@Param('orgId') orgId: string) {
    this.assertEnabled();
    return this.lwcaPoll.runForOrg(orgId);
  }

  /**
   * One-shot cleanup: delete Charge rows whose underlying LWCA invoice
   * isn't a rent invoice. Needed because LWCA stage silently ignores
   * `?lineItemType=Rent` so the upstream filter we added doesn't take
   * effect; the mapper-side filter catches them on new syncs, but
   * historical non-rent rows have to be purged out.
   */
  @Post('purge-non-rent/:orgId')
  @HttpCode(200)
  async purgeNonRentOrg(@Param('orgId') orgId: string) {
    this.assertEnabled();
    return this.purgeNonRent.runForOrg(orgId);
  }

  @Get('fixture-emails')
  listFixtureEmails() {
    this.assertEnabled();
    return { fixtures: this.seedFixtures.listFixtures() };
  }

  /**
   * Drop a fixture inbound email onto the case and run the inbound
   * pipeline inline. `fixture` body field selects one .eml from
   * fixtures/outlook/; omit to seed all of them.
   */
  @Post('seed-fixture-emails/:caseId')
  @HttpCode(200)
  async seedFixtureEmails(
    @Param('caseId') caseId: string,
    @Body(new ZodBody(SeedFixtureEmailsSchema)) body: { fixture?: string },
  ) {
    this.assertEnabled();
    if (body.fixture) {
      const result = await this.seedFixtures.seedOne(caseId, body.fixture);
      return { caseId, results: [result] };
    }
    const results = await this.seedFixtures.seedAll(caseId);
    return { caseId, results };
  }

  @Get('clock')
  status() {
    this.assertEnabled();
    const now = this.clock.now();
    return {
      now: now.toISOString(),
      offsetMs: this.clock.getOffsetMs(),
      offsetHumanDays: Math.round((this.clock.getOffsetMs() / 86400_000) * 10) / 10,
    };
  }

  /**
   * Move the system clock forward by N working days, then run chase tick +
   * daily digest synchronously so the demo sees fresh schedule entries and
   * fresh review-queue drafts immediately.
   */
  @Post('advance-clock')
  @HttpCode(200)
  async advance(@Body(new ZodBody(AdvanceClockSchema)) body: { workingDays: number }) {
    this.assertEnabled();
    const before = this.clock.now();
    const after = this.workingDay.addWorkingDays(before, body.workingDays);
    // Snap to 10:00 London on the target working day so any
    // ChaseScheduleEntry rows created by the immediately-following chase
    // tick (which set dueAt=09:00 London) will fire in the same
    // synchronous digest call. Without this snap, the entries' dueAt is
    // ~9 hours ahead of the clock and the digest produces no drafts.
    const target = new Date(todayAt9LondonAsUtc(after).getTime() + 60 * 60 * 1000);
    const deltaMs = target.getTime() - before.getTime();
    if (deltaMs <= 0) {
      throw new BadRequestException('addWorkingDays returned a non-positive delta');
    }
    this.clock.advanceMs(deltaMs);

    const tickResult = await this.chaseTick.runTick();
    const digestResult = await this.digest.runDigest();

    return {
      before: before.toISOString(),
      after: this.clock.now().toISOString(),
      workingDaysAdvanced: body.workingDays,
      deltaMs,
      chaseTick: tickResult,
      digest: digestResult,
    };
  }

  @Post('reset-clock')
  @HttpCode(200)
  reset() {
    this.assertEnabled();
    const before = this.clock.now();
    this.clock.reset();
    return { before: before.toISOString(), after: this.clock.now().toISOString() };
  }

  /**
   * Run the PromiseExpiryJob inline — the local-dev shortcut for the
   * scheduled @Cron at 09:00 London. Marks any ACTIVE promise whose date
   * is in the past as BROKEN and drafts the broken-promise email.
   */
  @Post('run-promise-expiry')
  @HttpCode(200)
  async runPromiseExpiry() {
    this.assertEnabled();
    return this.promiseExpiry.runOnce();
  }

  private assertEnabled(): void {
    if (process.env.DEV_TOOLS_ENABLED !== 'true') {
      throw new ForbiddenException('Dev tools are not enabled (set DEV_TOOLS_ENABLED=true)');
    }
  }
}
