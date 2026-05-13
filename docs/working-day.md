# Working-Day Calendar

The cadence engine and every WD-counting rule depends on a working-day calendar. This doc describes the source, caching, and the one module that owns this arithmetic.

## Source

`https://www.gov.uk/bank-holidays.json` — the official UK government feed. JSON, free, no auth, refreshed periodically by gov.uk.

Structure:

```json
{
  "england-and-wales": {
    "division": "england-and-wales",
    "events": [
      { "title": "New Year's Day", "date": "2025-01-01", "notes": "", "bunting": true },
      { "title": "Good Friday", "date": "2025-04-18", ... },
      ...
    ]
  },
  "scotland": { ... },
  "northern-ireland": { ... }
}
```

POC uses `england-and-wales` exclusively. Per-organisation calendar selection (Scottish or NI-based agencies) is a Phase 2 concern — the field exists on `OrganisationConfig.workingDayCalendar` but the loader only knows the one division for now.

## Caching

Daily refresh at 02:00 UTC via `WorkingDayCalendarSyncJob`. Cached in memory at process start and re-read after each successful sync.

On startup, if the cache is empty and the feed is unreachable, the service refuses to start with an explicit error. We don't fall back to a hard-coded list — better to fail loudly than to fire chase events on the wrong days.

For local dev, the latest fetched copy is also persisted to a file (`backend/.cache/bank-holidays.json`) so restarts don't re-fetch every time. Hosted: in-memory only; the daily sync handles it.

## Working-day arithmetic

One module, one place. `backend/src/common/working-day/working-day.service.ts`.

API:

```ts
class WorkingDayService {
  /** Is this date a working day (not Sat, not Sun, not a bank holiday)? */
  isWorkingDay(date: Date): boolean;

  /** Add N working days to a date. N=0 returns the same date if it's a working day, otherwise the next working day. */
  addWorkingDays(start: Date, n: number): Date;

  /** Count working days between two dates, exclusive of start, inclusive of end. */
  workingDaysBetween(start: Date, end: Date): number;

  /** Working days a charge has been overdue, where dueDate is WD0. */
  workingDaysOverdue(dueDate: Date, today: Date): number;
}
```

All inputs are treated as London-local dates (date-only, not date-times). Implementation converts UTC inputs to Europe/London at the boundary.

### `workingDaysOverdue` — the canonical definition

`dueDate` is **WD0**. The day a charge is due is not yet overdue. Working days are counted from `dueDate + 1` onwards.

```
Charge dueDate = Mon 5 May 2025
today = Thu 8 May 2025

Working days from 6 May to 8 May inclusive:
  Tue 6, Wed 7, Thu 8 → 3 working days

workingDaysOverdue = 3 → matches WD3 threshold
```

Holidays in the period are skipped. Weekends are skipped.

### `addWorkingDays` — used by the scheduler

```
dueDate = Mon 5 May 2025
addWorkingDays(dueDate, 3) → Thu 8 May 2025  // when WD3 chase fires
addWorkingDays(dueDate, 14) → Fri 23 May 2025  // when WD14 fires
```

If a bank holiday falls between `dueDate` and `dueDate + n`, the function skips it. So a charge due Thursday before a Good Friday bank holiday hits WD3 one day later than it would in a holiday-free month.

## Why a separate module

Three reasons:

1. **One implementation, one truth.** Working-day arithmetic shows up in: cadence scheduling, age display on charges, "X working days ago" formatting, S8 timing references. Inlining `if (date.getDay() === 6 || ...)` everywhere is how rules diverge silently.
2. **Testable in isolation.** Unit tests cover holiday edge cases (Easter, the 4-day August bank holiday, year boundaries) without spinning up the rule engine.
3. **Configurable per org later.** When we add `scotland` or `northern-ireland` divisions, the change is in this module only. Service signatures take an optional `calendar` parameter, defaulting to the org config's value.

## Tests

Lives in `__tests__/working-day.spec.ts`. Sample cases:

```ts
it('treats Saturday and Sunday as non-working', ...)
it('skips bank holidays', ...)
it('handles a charge due immediately before Easter weekend', () => {
  // Charge due Thu 17 Apr 2025; Good Fri 18 + Easter Mon 21 are holidays
  // Tue 22 is WD1, Wed 23 is WD2, Thu 24 is WD3
  expect(service.workingDaysOverdue(date('2025-04-17'), date('2025-04-24'))).toBe(3);
})
it('handles a charge due on a bank holiday itself', () => {
  // dueDate = Mon 5 May (bank holiday). The dueDate is still WD0;
  // first working day after is Tue 6 May = WD1
  expect(service.workingDaysOverdue(date('2025-05-05'), date('2025-05-08'))).toBe(3); // Tue, Wed, Thu
})
it('handles a year boundary with Christmas and New Year holidays', ...)
it('rejects an n < 0 to addWorkingDays', ...) // we don't go backwards
```

## Open items

- Whether to expose a UI mechanism for an organisation to mark additional non-working days (company holidays, regional days). Probably yes eventually, no for POC.
- Scotland and NI division support — schema field exists, loader doesn't use it yet.
