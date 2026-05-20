import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_CONFIG } from '../../../organisations/defaults';
import { renderTemplate, TemplateRenderError, type TemplateContext } from '../template-renderer';

function fullContext(): TemplateContext {
  return {
    tenant: { firstName: 'Jane', lastName: 'Tenant' },
    guarantor: { firstName: 'Helen', lastName: 'Guarantor' },
    property: { address: 'Flat 2, 12 High Street, London', name: 'Flat 2' },
    case: {
      balanceFormatted: '£2,400.00',
      balancePence: 240_000,
      chargeCount: 2,
      openedDate: '1 May 2026',
    },
    charges: [
      {
        referenceId: 'INV-2026-0001',
        dueDateFormatted: '1 Apr 2026',
        grossAmountFormatted: '£1,200.00',
        remainAmountFormatted: '£1,200.00',
        workingDaysOverdue: 14,
      },
      {
        referenceId: 'INV-2026-0002',
        dueDateFormatted: '1 May 2026',
        grossAmountFormatted: '£1,200.00',
        remainAmountFormatted: '£1,200.00',
        workingDaysOverdue: 5,
      },
    ],
    mostOverdueCharge: {
      referenceId: 'INV-2026-0001',
      dueDateFormatted: '1 Apr 2026',
      grossAmountFormatted: '£1,200.00',
      remainAmountFormatted: '£1,200.00',
      workingDaysOverdue: 14,
    },
    agency: { name: 'Acme Lettings', replyEmail: 'arrears@acme.co.uk' },
  };
}

describe('renderTemplate', () => {
  it('renders a template covering every documented variable', () => {
    const tmpl = `
Hi {{tenant.firstName}} {{tenant.lastName}},
Property: {{property.address}} ({{property.name}})
Balance: {{case.balanceFormatted}} ({{case.balancePence}})
Charges: {{case.chargeCount}}, opened {{case.openedDate}}
{{#charges}}
- {{referenceId}} due {{dueDateFormatted}}: gross {{grossAmountFormatted}}, remain {{remainAmountFormatted}} ({{workingDaysOverdue}} WD overdue)
{{/charges}}
Most overdue: {{mostOverdueCharge.referenceId}} ({{mostOverdueCharge.workingDaysOverdue}} WD)
Reply: {{agency.name}} <{{agency.replyEmail}}>`.trim();

    const rendered = renderTemplate(tmpl, fullContext());
    expect(rendered).toContain('Jane Tenant');
    expect(rendered).toContain('Flat 2, 12 High Street, London');
    expect(rendered).toContain('£2,400.00');
    expect(rendered).toContain('240000');
    expect(rendered).toContain('INV-2026-0001 due 1 Apr 2026');
    expect(rendered).toContain('INV-2026-0002');
    expect(rendered).toContain('Most overdue: INV-2026-0001 (14 WD)');
    expect(rendered).toContain('Acme Lettings <arrears@acme.co.uk>');
  });

  it('throws TemplateRenderError when a {{var}} is missing from the context', () => {
    const tmpl = 'Hi {{tenant.firstName}}, you owe {{case.balanceFormatted}} on {{property.address}}. Plan: {{paymentPlan}}.';
    expect(() => renderTemplate(tmpl, fullContext())).toThrowError(TemplateRenderError);
    try {
      renderTemplate(tmpl, fullContext());
    } catch (err) {
      const e = err as TemplateRenderError;
      expect(e.missing).toContain('paymentPlan');
    }
  });

  it('flags a typo in a nested path', () => {
    const tmpl = 'Hi {{tenant.firstName}}, see {{case.balanceFormated}}.'; // missing "t" in Formatted
    expect(() => renderTemplate(tmpl, fullContext())).toThrowError(/case\.balanceFormated/);
  });

  it('flags a section over a missing array', () => {
    const tmpl = 'Charges:\n{{#paymentPlans}}- {{name}}\n{{/paymentPlans}}';
    expect(() => renderTemplate(tmpl, fullContext())).toThrowError(/paymentPlans/);
  });
});

describe('built-in BRD templates render against a representative case', () => {
  it.each(
    ['templateWd3Tenant', 'templateWd5Tenant', 'templateWd8Tenant', 'templateWd14Tenant', 'templateBrokenPromise'] as const,
  )('renders %s without missing-variable errors', (key) => {
    const tmpl = DEFAULT_ORG_CONFIG[key] as string;
    const rendered = renderTemplate(tmpl, fullContext());
    expect(rendered).toContain('Jane');
    expect(rendered).toContain('£2,400.00');
    expect(rendered).toContain('INV-2026-0001');
    expect(rendered).toContain('Acme Lettings');
    expect(rendered).toContain('arrears@acme.co.uk');
  });
});
