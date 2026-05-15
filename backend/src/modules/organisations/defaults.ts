// Default values mirror docs/business-rules.md "Configuration (per organisation)".
// Template bodies are BRD-flavoured Mustache. The variables match the docs/
// business-rules.md "Template variables" list and are evaluated by
// modules/chase/digest/template-renderer.ts.
import { Prisma } from '@prisma/client';

// Mustache section syntax: {{#charges}}...{{/charges}} iterates the array
// with each item in scope. We do not use Handlebars `{{#each}}` even though
// the docs describe it that way — only Mustache is wired in.

const TEMPLATE_WD3 = `Hi {{tenant.firstName}},

Our records show {{case.balanceFormatted}} is currently outstanding on your rent at {{property.address}}. Please pay at your earliest convenience.

Outstanding charges ({{case.chargeCount}}):
{{#charges}}
- {{referenceId}}: {{remainAmountFormatted}} (due {{dueDateFormatted}}, {{workingDaysOverdue}} working days overdue)
{{/charges}}

If you've already paid, please ignore this message. If you anticipate any difficulty paying, please reply to {{agency.replyEmail}} so we can discuss.

Kind regards,
{{agency.name}}`;

const TEMPLATE_WD5 = `Hi {{tenant.firstName}},

This is a reminder that {{case.balanceFormatted}} remains overdue on your rent at {{property.address}}. Please clear the balance or contact us to discuss.

Outstanding charges:
{{#charges}}
- {{referenceId}}: {{remainAmountFormatted}} (due {{dueDateFormatted}}, {{workingDaysOverdue}} working days overdue)
{{/charges}}

If you're experiencing financial difficulty, please reply to {{agency.replyEmail}}. We may be able to agree a payment plan.

Kind regards,
{{agency.name}}`;

const TEMPLATE_WD8 = `Dear {{tenant.firstName}} {{tenant.lastName}},

The outstanding balance of {{case.balanceFormatted}} on your tenancy at {{property.address}} has now been overdue for 8 working days. This is a formal request to clear the balance immediately.

Outstanding charges:
{{#charges}}
- {{referenceId}}: {{remainAmountFormatted}} (due {{dueDateFormatted}}, {{workingDaysOverdue}} working days overdue)
{{/charges}}

If we do not hear from you, we will escalate this matter. Please contact {{agency.replyEmail}} as a matter of urgency.

Yours sincerely,
{{agency.name}}`;

const TEMPLATE_WD14 = `Dear {{tenant.firstName}} {{tenant.lastName}},

Despite our previous notices, {{case.balanceFormatted}} on your tenancy at {{property.address}} remains overdue. This matter has now been escalated within our organisation.

Outstanding charges:
{{#charges}}
- {{referenceId}}: {{remainAmountFormatted}} (due {{dueDateFormatted}}, {{workingDaysOverdue}} working days overdue)
{{/charges}}

The most overdue charge ({{mostOverdueCharge.referenceId}}) is now {{mostOverdueCharge.workingDaysOverdue}} working days past due. Please contact {{agency.replyEmail}} immediately to avoid further action.

Yours sincerely,
{{agency.name}}`;

const TEMPLATE_BROKEN_PROMISE = `Dear {{tenant.firstName}},

You previously agreed to pay {{case.balanceFormatted}} on your tenancy at {{property.address}}, but the expected payment has not arrived. Please contact {{agency.replyEmail}} to discuss next steps.

Outstanding charges:
{{#charges}}
- {{referenceId}}: {{remainAmountFormatted}} (due {{dueDateFormatted}})
{{/charges}}

Kind regards,
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
  templateWd3Tenant: TEMPLATE_WD3,
  templateWd5Tenant: TEMPLATE_WD5,
  templateWd8Tenant: TEMPLATE_WD8,
  templateWd14Tenant: TEMPLATE_WD14,
  templateBrokenPromise: TEMPLATE_BROKEN_PROMISE,
  hardTriggerOverrides: Prisma.JsonNull,
};
