// Shape returned by https://www.gov.uk/bank-holidays.json.
// Only the england-and-wales division is consumed in POC.

export interface BankHolidayEvent {
  title: string;
  date: string; // YYYY-MM-DD
  notes: string;
  bunting: boolean;
}

export interface BankHolidayDivision {
  division: string;
  events: BankHolidayEvent[];
}

export interface GovUkBankHolidays {
  'england-and-wales': BankHolidayDivision;
  scotland?: BankHolidayDivision;
  'northern-ireland'?: BankHolidayDivision;
}

export const WORKING_DAY_CALENDAR = 'england-and-wales' as const;
