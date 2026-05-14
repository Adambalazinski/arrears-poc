import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BankHolidaysLoader } from './bank-holidays.loader';
import { WORKING_DAY_CALENDAR, type GovUkBankHolidays } from './types';

/**
 * One implementation, one truth. All working-day arithmetic in the system
 * routes through this service — see docs/working-day.md.
 *
 * Inputs are treated as London-local calendar dates. The time-of-day on a
 * passed-in `Date` is ignored; we project onto Europe/London at the boundary.
 */
@Injectable()
export class WorkingDayService implements OnModuleInit {
  private readonly logger = new Logger(WorkingDayService.name);

  /** YYYY-MM-DD strings of bank holidays in the england-and-wales division. */
  private holidays: Set<string> = new Set();

  /** True once we've successfully loaded a calendar at least once. */
  private initialized = false;

  constructor(private readonly loader: BankHolidaysLoader) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /**
   * Daily refresh at 02:00 UTC. Re-fetches the gov.uk feed and replaces the
   * in-memory holiday set on success. A failed refresh leaves the previous
   * calendar in place rather than blanking it.
   */
  @Cron('0 2 * * *')
  async daily(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      this.logger.error(
        `daily bank-holiday refresh failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async refresh(): Promise<void> {
    const data = await this.loader.load();
    this.applyCalendar(data);
    this.initialized = true;
  }

  /** Test/seed hook: install a calendar without going through the loader. */
  applyCalendar(data: GovUkBankHolidays): void {
    const division = data[WORKING_DAY_CALENDAR];
    if (!division) throw new Error(`Missing division "${WORKING_DAY_CALENDAR}" in feed`);
    this.holidays = new Set(division.events.map((e) => e.date));
    this.initialized = true;
  }

  isWorkingDay(date: Date): boolean {
    return this.isWorkingDayYmd(toLondonYmd(date));
  }

  /**
   * Add N working days. `n === 0` returns the same date when it's a working
   * day, otherwise the next working day. Negative N is rejected — the
   * scheduler never needs to walk backwards.
   */
  addWorkingDays(start: Date, n: number): Date {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`addWorkingDays: n must be a non-negative integer (got ${n})`);
    }
    this.assertReady();
    let cur = toLondonYmd(start);
    if (n === 0) {
      while (!this.isWorkingDayYmd(cur)) cur = addOneDayYmd(cur);
      return ymdToUtcDate(cur);
    }
    let count = 0;
    while (count < n) {
      cur = addOneDayYmd(cur);
      if (this.isWorkingDayYmd(cur)) count++;
    }
    return ymdToUtcDate(cur);
  }

  /** Working days strictly after `start` up to and including `end`. */
  workingDaysBetween(start: Date, end: Date): number {
    this.assertReady();
    const startYmd = toLondonYmd(start);
    const endYmd = toLondonYmd(end);
    if (endYmd <= startYmd) return 0;
    let cur = addOneDayYmd(startYmd);
    let count = 0;
    while (cur <= endYmd) {
      if (this.isWorkingDayYmd(cur)) count++;
      cur = addOneDayYmd(cur);
    }
    return count;
  }

  /**
   * Working days a charge has been overdue. `dueDate` is WD0; the day a
   * charge is due is not yet overdue. Equivalent to
   * `workingDaysBetween(dueDate, today)` but the name is what the rules
   * read like in code.
   */
  workingDaysOverdue(dueDate: Date, today: Date): number {
    return this.workingDaysBetween(dueDate, today);
  }

  private isWorkingDayYmd(ymd: string): boolean {
    const dow = londonWeekday(ymd);
    if (dow === 0 || dow === 6) return false;
    if (this.holidays.has(ymd)) return false;
    return true;
  }

  private assertReady(): void {
    if (!this.initialized) {
      throw new Error('WorkingDayService used before bank-holiday calendar was loaded');
    }
  }
}

// ---------- Local date helpers ----------
// We treat Date inputs as "the calendar date this Date refers to in
// Europe/London", which dodges DST/UTC-shift bugs by keeping the rest of
// the arithmetic on plain YMD strings.

const ymdFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function toLondonYmd(date: Date): string {
  const parts = ymdFormatter.formatToParts(date);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${d}`;
}

function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const parts = ymd.split('-');
  if (parts.length !== 3) throw new Error(`Invalid YMD: ${ymd}`);
  return { y: Number(parts[0]), m: Number(parts[1]), d: Number(parts[2]) };
}

function addOneDayYmd(ymd: string): string {
  const { y, m, d } = parseYmd(ymd);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return formatUtcAsYmd(dt);
}

function formatUtcAsYmd(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Weekday of a YYYY-MM-DD calendar date: 0=Sun, 1=Mon, ..., 6=Sat. */
function londonWeekday(ymd: string): number {
  const { y, m, d } = parseYmd(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Build a UTC-midnight Date for a given London calendar date. */
function ymdToUtcDate(ymd: string): Date {
  const { y, m, d } = parseYmd(ymd);
  return new Date(Date.UTC(y, m - 1, d));
}
