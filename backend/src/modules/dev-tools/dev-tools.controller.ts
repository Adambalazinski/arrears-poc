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
import { LWCA_INVOICE_CLIENT, type LwcaInvoiceClient } from '../../integrations/lwca/lwca-invoice.client';
import { OutlookInboundPollJob } from '../inbound/jobs/outlook-inbound-poll.job';
import { PromiseExpiryJob } from '../promises/jobs/promise-expiry.job';
import { PurgeNonRentService } from './purge-non-rent.service';
import { ResetDemoService } from './reset-demo.service';
import { SeedFixtureEmailsService } from './seed-fixture-emails.service';
import { Inject } from '@nestjs/common';

const SetClockSchema = z
  .object({
    /** Full ISO 8601 timestamp with offset, e.g. "2026-05-25T09:00:00+01:00". */
    iso: z.string().datetime({ offset: true }).optional(),
    /**
     * Wall-clock time on TODAY in Europe/London, as "HH:mm" or "HH:mm:ss".
     * Most useful for testing the daily digest, which fires at 09:00 London.
     */
    todayAt: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  })
  .refine((v) => (v.iso != null) !== (v.todayAt != null), {
    message: 'Provide exactly one of iso or todayAt',
  });

const AdvanceClockSchema = z
  .object({
    /**
     * Snaps to 10:00 London on the target working day so chase entries
     * (dueAt=09:00) fire in the same request. 1..60 inclusive.
     */
    workingDays: z.number().int().min(1).max(60).optional(),
    /**
     * Plain hour-level advance. Useful when you want to land at a
     * specific point inside the day (e.g. just past 09:00 to fire the
     * digest, or just past midnight to roll the day over). No snap.
     * 1..240 inclusive (= 10 days max).
     */
    hours: z.number().int().min(1).max(240).optional(),
  })
  .refine((v) => (v.workingDays != null) !== (v.hours != null), {
    message: 'Provide exactly one of workingDays or hours',
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
    private readonly resetDemo: ResetDemoService,
    private readonly inboundPoll: OutlookInboundPollJob,
    @Inject(LWCA_INVOICE_CLIENT) private readonly lwca: LwcaInvoiceClient,
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

  /**
   * Wipe all per-case derived state for one org and re-sync from
   * upstream. Used to replay the demo flow from a clean slate without
   * losing credentials / upstream caches.
   */
  @Post('reset-demo/:orgId')
  @HttpCode(200)
  async resetDemoOrg(@Param('orgId') orgId: string) {
    this.assertEnabled();
    return this.resetDemo.runForOrg(orgId);
  }

  /**
   * Debug: return the raw LWCA arrears list (with line items) so we can
   * see what's coming back from stage and why the mapper might drop it.
   */
  @Get('inspect-lwca/:orgId')
  async inspectLwca(@Param('orgId') orgId: string) {
    this.assertEnabled();
    try {
      const raw = await this.lwca.listAllRaw(orgId);
      return {
        organisationId: orgId,
        count: raw.length,
        invoices: raw.map((inv) => ({
          id: inv.id,
          status: inv.status,
          remainAmount: inv.remainAmount,
          dueDate: inv.dueDate,
          tenancyId: inv.tenancyId,
          type: inv.type,
          description: inv.description,
          lineItems: inv.lineItems,
        })),
      };
    } catch (err) {
      const e = err as Error & { status?: number; stack?: string };
      return {
        organisationId: orgId,
        error: {
          name: e.name,
          message: e.message,
          status: e.status,
          stack: e.stack?.split('\n').slice(0, 8),
        },
      };
    }
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
  async advance(
    @Body(new ZodBody(AdvanceClockSchema))
    body: { workingDays?: number; hours?: number },
  ) {
    this.assertEnabled();
    const before = this.clock.now();
    let deltaMs: number;
    if (body.workingDays != null) {
      // Working-day mode: jump to 10:00 London on the target working day
      // so any chase entries created by the synchronous tick (which set
      // dueAt=09:00 London) fall due before the digest runs.
      const after = this.workingDay.addWorkingDays(before, body.workingDays);
      const target = new Date(todayAt9LondonAsUtc(after).getTime() + 60 * 60 * 1000);
      deltaMs = target.getTime() - before.getTime();
    } else {
      // Hour mode: plain ms advance, no snap. The Zod schema guarantees
      // exactly one of workingDays / hours is provided.
      deltaMs = body.hours! * 60 * 60 * 1000;
    }
    if (deltaMs <= 0) {
      throw new BadRequestException(`advance produced a non-positive delta (${deltaMs}ms)`);
    }
    this.clock.advanceMs(deltaMs);

    const tickResult = await this.chaseTick.runTick();
    const digestResult = await this.digest.runDigest();

    return {
      before: before.toISOString(),
      after: this.clock.now().toISOString(),
      workingDaysAdvanced: body.workingDays ?? null,
      hoursAdvanced: body.hours ?? null,
      deltaMs,
      chaseTick: tickResult,
      digest: digestResult,
    };
  }

  /**
   * Set the clock to a specific moment. Two input flavours:
   *   - `iso`:    full ISO 8601 with offset, absolute.
   *   - `todayAt`: "HH:mm[:ss]" interpreted in Europe/London for today's date.
   *
   * Most useful for testing the daily-digest pipeline at the 09:00
   * London boundary. After setting, runs the chase tick and the digest
   * inline so the same request shows the effect.
   *
   * Unlike advance-clock this can move the clock *backwards*; useful
   * for "rewind to just before the digest fires, then nudge forward".
   */
  @Post('set-clock')
  @HttpCode(200)
  async setClock(
    @Body(new ZodBody(SetClockSchema)) body: { iso?: string; todayAt?: string },
  ) {
    this.assertEnabled();
    const before = this.clock.now();
    const target = body.iso != null ? new Date(body.iso) : todayAtLondon(body.todayAt!);
    if (Number.isNaN(target.getTime())) {
      throw new BadRequestException(`Invalid target: ${body.iso ?? body.todayAt}`);
    }
    const deltaMs = target.getTime() - before.getTime();
    this.clock.advanceMs(deltaMs);

    const tickResult = await this.chaseTick.runTick();
    const digestResult = await this.digest.runDigest();

    return {
      before: before.toISOString(),
      target: target.toISOString(),
      after: this.clock.now().toISOString(),
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

  /**
   * Run the Outlook inbound poll inline — the local-dev shortcut for the
   * scheduled @Cron in OutlookInboundPollJob (every 5 min). Useful for
   * exercising the live inbound path end-to-end without waiting for the
   * next tick. Honours the same INBOUND_MODE gating as the cron: when
   * INBOUND_MODE is not "outlook" this still runs (so fixtures-style
   * smoke tests work), but listInbound will fail unless OUTLOOK_*
   * credentials are configured.
   */
  @Post('run-inbound-poll')
  @HttpCode(200)
  async runInboundPoll() {
    this.assertEnabled();
    return this.inboundPoll.runOnce();
  }

  private assertEnabled(): void {
    if (process.env.DEV_TOOLS_ENABLED !== 'true') {
      throw new ForbiddenException('Dev tools are not enabled (set DEV_TOOLS_ENABLED=true)');
    }
  }
}

/**
 * Given "HH:mm" or "HH:mm:ss", return the UTC Date for that wall-clock
 * moment today in Europe/London. Auto-handles BST vs GMT by probing the
 * tz offset for today's date.
 */
function todayAtLondon(hhmmss: string): Date {
  const todayLondonYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const offsetStr = londonOffsetForYmd(todayLondonYmd);
  const time = hhmmss.length === 5 ? `${hhmmss}:00` : hhmmss;
  return new Date(`${todayLondonYmd}T${time}${offsetStr}`);
}

function londonOffsetForYmd(ymd: string): string {
  // Probe at noon UTC on the requested day — safely away from the
  // 01:00 UTC DST-transition boundary.
  const probe = new Date(`${ymd}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    timeZoneName: 'shortOffset',
  }).formatToParts(probe);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  if (tz === 'GMT') return '+00:00';
  const match = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return '+00:00';
  const sign = match[1] ?? '+';
  const hh = (match[2] ?? '0').padStart(2, '0');
  const mm = match[3] ?? '00';
  return `${sign}${hh}:${mm}`;
}
