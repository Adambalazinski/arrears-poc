// Default values mirror docs/business-rules.md "Configuration (per organisation)".
// Template bodies are placeholders — step 5.3 will seed BRD-accurate copy.
import { Prisma } from '@prisma/client';

const PLACEHOLDER_TEMPLATE_WD3 = `Hi {{tenant.firstName}},

Our records show {{case.balanceFormatted}} is currently outstanding on your rent at {{property.address}}. Please pay at your earliest convenience.

{{agency.name}}`;

const PLACEHOLDER_TEMPLATE_WD5 = `Hi {{tenant.firstName}},

This is a reminder that {{case.balanceFormatted}} is overdue. Please contact us if you anticipate any difficulty paying.

{{agency.name}}`;

const PLACEHOLDER_TEMPLATE_WD8 = `Dear {{tenant.firstName}} {{tenant.lastName}},

The outstanding balance of {{case.balanceFormatted}} on {{property.address}} has now been overdue for 8 working days. This is a formal request to clear the balance.

{{agency.name}}`;

const PLACEHOLDER_TEMPLATE_WD14 = `Dear {{tenant.firstName}} {{tenant.lastName}},

Despite previous notices, {{case.balanceFormatted}} remains overdue. This matter has now been escalated.

{{agency.name}}`;

const PLACEHOLDER_TEMPLATE_BROKEN_PROMISE = `Dear {{tenant.firstName}},

You previously agreed to pay {{case.balanceFormatted}} but the expected payment has not arrived. Please contact us.

{{agency.name}}`;

export const DEFAULT_ORG_CONFIG: Omit<
  Prisma.OrganisationConfigCreateInput,
  'organisation' | 'organisationId'
> = {
  chaseDayFirst: 3,
  chaseDaySecond: 5,
  chaseDayThird: 8,
  chaseDayExecNotify: 14,
  workingDayCalendar: 'england-and-wales',
  s8RentMonthsThreshold: 3,
  s8WeeksThreshold: 13,
  pollingIntervalMinutes: 15,
  autoSendEnabled: false,
  aiClassificationModel: 'claude-haiku-4-5',
  aiDraftModel: 'claude-sonnet-4-6',
  aiConfidenceThreshold: new Prisma.Decimal('0.75'),
  templateWd3Tenant: PLACEHOLDER_TEMPLATE_WD3,
  templateWd5Tenant: PLACEHOLDER_TEMPLATE_WD5,
  templateWd8Tenant: PLACEHOLDER_TEMPLATE_WD8,
  templateWd14Tenant: PLACEHOLDER_TEMPLATE_WD14,
  templateBrokenPromise: PLACEHOLDER_TEMPLATE_BROKEN_PROMISE,
  hardTriggerOverrides: Prisma.JsonNull,
};
