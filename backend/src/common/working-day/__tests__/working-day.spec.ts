import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BankHolidaysLoader } from '../bank-holidays.loader';
import { WorkingDayService } from '../working-day.service';
import type { GovUkBankHolidays } from '../types';

// England-and-Wales bank holidays relevant to the test cases. Mirrors the
// gov.uk feed shape so we exercise the same applyCalendar() path used in prod.
const FIXTURE: GovUkBankHolidays = {
  'england-and-wales': {
    division: 'england-and-wales',
    events: [
      { title: 'Christmas Day', date: '2024-12-25', notes: '', bunting: true },
      { title: 'Boxing Day', date: '2024-12-26', notes: '', bunting: true },
      { title: "New Year's Day", date: '2025-01-01', notes: '', bunting: true },
      { title: 'Good Friday', date: '2025-04-18', notes: '', bunting: false },
      { title: 'Easter Monday', date: '2025-04-21', notes: '', bunting: true },
      { title: 'Early May bank holiday', date: '2025-05-05', notes: '', bunting: true },
      { title: 'Spring bank holiday', date: '2025-05-26', notes: '', bunting: true },
      { title: 'Summer bank holiday', date: '2025-08-25', notes: '', bunting: true },
      { title: 'Christmas Day', date: '2025-12-25', notes: '', bunting: true },
      { title: 'Boxing Day', date: '2025-12-26', notes: '', bunting: true },
      { title: "New Year's Day", date: '2026-01-01', notes: '', bunting: true },
    ],
  },
};

const date = (ymd: string): Date => new Date(`${ymd}T00:00:00Z`);

function makeService(): WorkingDayService {
  // The loader is irrelevant for these tests; applyCalendar injects the
  // fixture directly. We still pass a dummy so the constructor type is happy.
  const loader = {} as BankHolidaysLoader;
  const svc = new WorkingDayService(loader);
  svc.applyCalendar(FIXTURE);
  return svc;
}

describe('WorkingDayService', () => {
  let svc: WorkingDayService;

  beforeEach(() => {
    svc = makeService();
  });

  describe('isWorkingDay', () => {
    it('treats Saturday and Sunday as non-working', () => {
      expect(svc.isWorkingDay(date('2025-05-10'))).toBe(false); // Saturday
      expect(svc.isWorkingDay(date('2025-05-11'))).toBe(false); // Sunday
    });

    it('treats a weekday as working', () => {
      expect(svc.isWorkingDay(date('2025-05-13'))).toBe(true); // Tuesday
    });

    it('skips bank holidays', () => {
      expect(svc.isWorkingDay(date('2025-04-18'))).toBe(false); // Good Friday
      expect(svc.isWorkingDay(date('2025-04-21'))).toBe(false); // Easter Monday
      expect(svc.isWorkingDay(date('2025-05-05'))).toBe(false); // Early May
      expect(svc.isWorkingDay(date('2025-12-25'))).toBe(false);
      expect(svc.isWorkingDay(date('2025-12-26'))).toBe(false);
    });
  });

  describe('workingDaysOverdue', () => {
    it('returns 0 when today is the due date', () => {
      expect(svc.workingDaysOverdue(date('2025-05-13'), date('2025-05-13'))).toBe(0);
    });

    it('returns 0 when today is before the due date', () => {
      expect(svc.workingDaysOverdue(date('2025-05-13'), date('2025-05-12'))).toBe(0);
    });

    it('counts a simple three-day run', () => {
      // Mon 12 → Tue 13, Wed 14, Thu 15 = 3 working days
      expect(svc.workingDaysOverdue(date('2025-05-12'), date('2025-05-15'))).toBe(3);
    });

    it('handles a charge due immediately before Easter weekend', () => {
      // dueDate = Thu 17 Apr 2025
      // Fri 18 (Good Friday, holiday), Sat 19, Sun 20, Mon 21 (Easter Mon, holiday) skipped
      // Tue 22 = WD1, Wed 23 = WD2, Thu 24 = WD3
      expect(svc.workingDaysOverdue(date('2025-04-17'), date('2025-04-24'))).toBe(3);
    });

    it('handles a charge due on a bank holiday itself', () => {
      // dueDate = Mon 5 May 2025 (Early May bank holiday). It is still WD0.
      // First working day after is Tue 6 May = WD1. Through Thu 8 = WD3.
      expect(svc.workingDaysOverdue(date('2025-05-05'), date('2025-05-08'))).toBe(3);
    });

    it('handles a year boundary with Christmas and New Year holidays', () => {
      // dueDate = Mon 22 Dec 2025
      // Tue 23 = WD1, Wed 24 = WD2,
      // Thu 25 (holiday), Fri 26 (holiday), Sat 27, Sun 28 skipped,
      // Mon 29 = WD3, Tue 30 = WD4, Wed 31 = WD5,
      // Thu 1 Jan (holiday) skipped,
      // Fri 2 Jan = WD6
      expect(svc.workingDaysOverdue(date('2025-12-22'), date('2026-01-02'))).toBe(6);
    });

    it('does not count the due date itself', () => {
      // dueDate Tuesday, today Wednesday → 1
      expect(svc.workingDaysOverdue(date('2025-05-13'), date('2025-05-14'))).toBe(1);
    });

    it('skips a single intervening holiday', () => {
      // dueDate Fri 23 May; Mon 26 May is Spring bank holiday; Tue 27 = WD1
      expect(svc.workingDaysOverdue(date('2025-05-23'), date('2025-05-27'))).toBe(1);
    });
  });

  describe('addWorkingDays', () => {
    it('returns the same date for n=0 on a working day', () => {
      // Tue 13 May 2025 is a working day
      expect(toYmd(svc.addWorkingDays(date('2025-05-13'), 0))).toBe('2025-05-13');
    });

    it('rolls forward for n=0 on a weekend', () => {
      // Sat 10 May → Mon 12 May
      expect(toYmd(svc.addWorkingDays(date('2025-05-10'), 0))).toBe('2025-05-12');
    });

    it('rolls forward for n=0 on a bank holiday', () => {
      // Mon 5 May (Early May) → Tue 6 May
      expect(toYmd(svc.addWorkingDays(date('2025-05-05'), 0))).toBe('2025-05-06');
    });

    it('matches the doc example: WD3 anchored on a bank-holiday Monday', () => {
      // From Mon 5 May (bank holiday): WD1 Tue 6, WD2 Wed 7, WD3 Thu 8
      expect(toYmd(svc.addWorkingDays(date('2025-05-05'), 3))).toBe('2025-05-08');
    });

    it('matches the doc example: WD14 anchored on a bank-holiday Monday', () => {
      expect(toYmd(svc.addWorkingDays(date('2025-05-05'), 14))).toBe('2025-05-23');
    });

    it('rejects negative n', () => {
      expect(() => svc.addWorkingDays(date('2025-05-13'), -1)).toThrow(/non-negative/);
    });

    it('rejects non-integer n', () => {
      expect(() => svc.addWorkingDays(date('2025-05-13'), 1.5)).toThrow(/integer/);
    });
  });

  describe('workingDaysBetween', () => {
    it('matches workingDaysOverdue semantics', () => {
      // exclusive of start, inclusive of end
      expect(svc.workingDaysBetween(date('2025-05-12'), date('2025-05-15'))).toBe(3);
    });

    it('returns 0 when end is before start', () => {
      expect(svc.workingDaysBetween(date('2025-05-15'), date('2025-05-12'))).toBe(0);
    });
  });

  describe('initialization', () => {
    it('refuses to compute before applyCalendar/refresh has run', () => {
      const fresh = new WorkingDayService({} as BankHolidaysLoader);
      expect(() => fresh.workingDaysOverdue(date('2025-01-01'), date('2025-01-05'))).toThrow(
        /before bank-holiday calendar was loaded/,
      );
    });

    it('refresh propagates loader failure so onModuleInit can surface it', async () => {
      const failingLoader = {
        load: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as BankHolidaysLoader;
      const fresh = new WorkingDayService(failingLoader);
      await expect(fresh.refresh()).rejects.toThrow(/boom/);
    });
  });
});

function toYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
