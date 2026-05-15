/**
 * Today's date in Europe/London, at 09:00 local time, expressed as a UTC
 * `Date`. Used for `ChaseScheduleEntry.dueAt` per R3.3.
 *
 * Handles BST/GMT without a date library: build a candidate at 09:00 UTC for
 * the right calendar date, format it back to London, and use the resulting
 * hour to know whether we need to subtract an hour (BST = UTC+1).
 */
export function todayAt9LondonAsUtc(now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')!.value);
  const m = Number(parts.find((p) => p.type === 'month')!.value);
  const d = Number(parts.find((p) => p.type === 'day')!.value);

  // Candidate: 09:00 UTC on the same calendar date.
  const candidate = new Date(Date.UTC(y, m - 1, d, 9, 0, 0, 0));

  // What hour does that read as in London?
  const londonHour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(candidate),
  );

  // londonHour - 9 is the offset; usually 0 (GMT) or 1 (BST).
  return new Date(candidate.getTime() - (londonHour - 9) * 60 * 60 * 1000);
}
