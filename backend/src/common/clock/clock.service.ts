import { Injectable, Logger } from '@nestjs/common';

/**
 * Single source of "now()" for jobs and rule evaluation.
 *
 * In production this is just `new Date()`. In dev (DEV_TOOLS_ENABLED=true),
 * the demo control panel can call `advanceMs` / `setOffsetMs` to jump
 * forward without waiting for real time to pass — the chase tick and the
 * daily digest both call `clock.now()` so they observe the shifted time
 * immediately.
 *
 * Offset is in-memory only — a backend restart resets it to zero. Demo
 * walkthroughs that need persistence can re-advance after restart.
 */
@Injectable()
export class Clock {
  private readonly logger = new Logger(Clock.name);
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  /** Add `ms` (signed) to the current offset. Use addOffsetForWorkingDays
   *  from the dev-tools controller to advance by N working days. */
  advanceMs(ms: number): void {
    this.offsetMs += ms;
    this.logger.warn(`Clock advanced by ${ms} ms (total offset ${this.offsetMs} ms)`);
  }

  reset(): void {
    if (this.offsetMs !== 0) {
      this.logger.warn(`Clock reset (was ${this.offsetMs} ms ahead)`);
    }
    this.offsetMs = 0;
  }

  getOffsetMs(): number {
    return this.offsetMs;
  }
}
