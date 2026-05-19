import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateBreathingSpace,
  deactivateBreathingSpace,
  formatPence,
  getCase,
  propertyLine,
  refreshCase,
  tenantNameFromDetail,
  type BreathingSpaceSource,
  type CaseEventRow,
  type CaseRowDetail,
  type ChargeRowDetail,
  type EscalationFlagKind,
  type EscalationFlagRow,
} from '@/lib/api-cases';

export function CaseDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) return <p className="p-6">Missing case id.</p>;

  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['case', id], queryFn: () => getCase(id) });
  const refresh = useMutation({
    mutationFn: () => refreshCase(id),
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['case', id] }),
  });

  if (detail.isLoading) return <p className="p-6 text-muted-foreground">Loading…</p>;
  if (detail.error || !detail.data) {
    return (
      <p className="p-6 text-destructive">
        Failed to load case: {detail.error instanceof Error ? detail.error.message : 'unknown'}
      </p>
    );
  }
  const c = detail.data;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            to={`/organisations/${encodeURIComponent(c.organisationId)}/cases`}
            className="text-sm underline text-muted-foreground"
          >
            ← cases
          </Link>
          <div>
            <h1 className="text-xl font-semibold">{tenantNameFromDetail(c)}</h1>
            <code className="text-xs text-muted-foreground">case {c.id}</code>
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">
            {c.status === 'ACTIVE' ? 'Active' : 'Closed'}
          </span>
          <button
            type="button"
            className="rounded bg-primary text-primary-foreground px-3 py-1.5 disabled:opacity-50"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {refresh.isPending ? 'Refreshing…' : 'Refresh from upstream'}
          </button>
        </div>
      </header>

      <section className="px-6 py-5 max-w-5xl mx-auto space-y-8">
        <SummaryCard c={c} />
        <EscalationStrip flags={c.escalationFlags} />
        <BreathingSpaceCard caseId={c.id} active={c.breathingSpaceActive} status={c.status} />
        <ChargesTable charges={c.charges} />
        <Timeline events={c.events} />
        <CommunicationsPlaceholder />
      </section>
    </main>
  );
}

function SummaryCard({ c }: { c: CaseRowDetail }): JSX.Element {
  return (
    <div className="border border-border rounded p-4 grid grid-cols-2 gap-4">
      <div>
        <h2 className="text-sm font-medium text-muted-foreground mb-2">Tenancy</h2>
        <dl className="grid grid-cols-[140px_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">Tenancy id</dt>
          <dd className="font-mono">{c.tenancy.id}</dd>
          <dt className="text-muted-foreground">Reference</dt>
          <dd>{c.tenancy.reference ?? '—'}</dd>
          <dt className="text-muted-foreground">Property</dt>
          <dd>{propertyLine(c.tenancy)}</dd>
          <dt className="text-muted-foreground">Rent day</dt>
          <dd>{c.tenancy.rentDayOfMonth ?? '—'}</dd>
          <dt className="text-muted-foreground">Rent (informational)</dt>
          <dd>{formatPence(c.tenancy.rentAmountPence)}</dd>
          <dt className="text-muted-foreground">Tenants</dt>
          <dd>
            {c.tenancy.tenancyContacts
              .filter((tc) => tc.role === 'TENANT')
              .map((tc) => (
                <div key={tc.contactId} className="text-xs">
                  <span>{[tc.contact.firstName, tc.contact.lastName].filter(Boolean).join(' ')}</span>{' '}
                  <span className="text-muted-foreground">{tc.contact.primaryEmail ?? ''}</span>
                </div>
              ))}
          </dd>
          <dt className="text-muted-foreground">Guarantors</dt>
          <dd>
            {c.tenancy.tenancyContacts.filter((tc) => tc.role === 'GUARANTOR').length === 0 ? (
              <span className="text-xs text-muted-foreground">—</span>
            ) : (
              c.tenancy.tenancyContacts
                .filter((tc) => tc.role === 'GUARANTOR')
                .map((tc) => (
                  <div key={tc.contactId} className="text-xs">
                    <span>{[tc.contact.firstName, tc.contact.lastName].filter(Boolean).join(' ')}</span>{' '}
                    <span className="text-muted-foreground">{tc.contact.primaryEmail ?? ''}</span>
                  </div>
                ))
            )}
          </dd>
        </dl>
      </div>
      <div>
        <h2 className="text-sm font-medium text-muted-foreground mb-2">Status</h2>
        <dl className="grid grid-cols-[140px_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">Balance</dt>
          <dd className="text-lg font-semibold">{formatPence(c.lastKnownBalancePence)}</dd>
          <dt className="text-muted-foreground">Opened</dt>
          <dd>{new Date(c.openedAt).toLocaleDateString('en-GB')}</dd>
          <dt className="text-muted-foreground">Closed</dt>
          <dd>{c.closedAt ? new Date(c.closedAt).toLocaleDateString('en-GB') : '—'}</dd>
          <dt className="text-muted-foreground">S8 eligible</dt>
          <dd>{c.s8Eligible ? 'YES' : 'no'}</dd>
          <dt className="text-muted-foreground">Breathing space</dt>
          <dd>{c.breathingSpaceActive ? 'ACTIVE' : 'no'}</dd>
          <dt className="text-muted-foreground">Awaiting handler</dt>
          <dd>{c.awaitingHandlerAction ? 'YES' : 'no'}</dd>
        </dl>
      </div>
    </div>
  );
}

function ChargesTable({ charges }: { charges: ChargeRowDetail[] }): JSX.Element {
  return (
    <div className="border border-border rounded">
      <h2 className="text-sm font-medium text-muted-foreground px-4 py-3 border-b border-border">
        Charges ({charges.length})
      </h2>
      {charges.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No charges attached.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2 font-medium text-muted-foreground">Invoice</th>
              <th className="px-3 py-2 font-medium text-muted-foreground">Due</th>
              <th className="px-3 py-2 font-medium text-muted-foreground">Gross</th>
              <th className="px-3 py-2 font-medium text-muted-foreground">Remain</th>
              <th className="px-3 py-2 font-medium text-muted-foreground">WD</th>
              <th className="px-3 py-2 font-medium text-muted-foreground">Stage</th>
              <th className="px-3 py-2 font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {charges.map((ch) => (
              <tr key={ch.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{ch.lwcaInvoiceId}</td>
                <td className="px-3 py-2">{new Date(ch.dueDate).toLocaleDateString('en-GB')}</td>
                <td className="px-3 py-2">{formatPence(ch.grossAmountPence)}</td>
                <td className="px-3 py-2">{formatPence(ch.lastKnownRemainAmountPence)}</td>
                <td className="px-3 py-2">{ch.workingDaysOverdue}</td>
                <td className="px-3 py-2">{ch.currentStage}</td>
                <td className="px-3 py-2">{ch.lastKnownStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Timeline({ events }: { events: CaseEventRow[] }): JSX.Element {
  return (
    <div className="border border-border rounded">
      <h2 className="text-sm font-medium text-muted-foreground px-4 py-3 border-b border-border">
        Timeline ({events.length})
      </h2>
      {events.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No events yet.</p>
      ) : (
        <ol className="divide-y divide-border">
          {events.map((e) => (
            <li key={e.id} className="px-4 py-2 text-sm flex items-baseline gap-3">
              <code className="text-xs text-muted-foreground w-44 shrink-0">
                {new Date(e.occurredAt).toLocaleString('en-GB')}
              </code>
              <span className="font-medium w-56 shrink-0">{e.kind}</span>
              <code className="text-xs text-muted-foreground break-all">
                {summarisePayload(e.payloadJson)}
              </code>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const FLAG_LABEL: Record<EscalationFlagKind, string> = {
  S8_ELIGIBLE: 'Section 8 eligible',
  BREATHING_SPACE: 'Breathing space',
  HARDSHIP_INDICATED: 'Hardship indicated',
  MENTAL_HEALTH_INDICATED: 'Mental-health indicated',
  THIRD_PARTY_INVOLVED: 'Third party involved',
  LIABILITY_DISPUTED: 'Liability disputed',
  DOMESTIC_CIRCUMSTANCES: 'Domestic circumstances',
  AI_CONFIDENCE_FAILURE: 'AI confidence failure',
  STALE_BALANCE_60D: 'Stale balance (60d)',
  REPEATED_SMALL_PAYMENTS: 'Repeated small payments',
};

function EscalationStrip({ flags }: { flags: EscalationFlagRow[] }): JSX.Element | null {
  if (flags.length === 0) return null;
  return (
    <div className="border border-amber-300 bg-amber-50/40 rounded p-4">
      <h2 className="text-sm font-medium text-amber-800 mb-2">
        Active escalations ({flags.length})
      </h2>
      <ul className="space-y-1.5">
        {flags.map((f) => (
          <li key={f.id} className="text-sm flex items-baseline gap-3">
            <span className="font-medium text-amber-900 min-w-[200px]">
              {FLAG_LABEL[f.kind] ?? f.kind}
            </span>
            <span className="text-xs text-muted-foreground">
              raised {new Date(f.raisedAt).toLocaleString('en-GB')}
            </span>
            <span className="text-xs text-muted-foreground break-all">{f.raisedReason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BreathingSpaceCard({
  caseId,
  active,
  status,
}: {
  caseId: string;
  active: boolean;
  status: 'ACTIVE' | 'CLOSED';
}): JSX.Element {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<BreathingSpaceSource>('FORMAL_NOTIFICATION');
  const [note, setNote] = useState('');

  const reset = () => {
    setOpen(false);
    setNote('');
    setSource('FORMAL_NOTIFICATION');
  };

  const activate = useMutation({
    mutationFn: () =>
      activateBreathingSpace(caseId, {
        source,
        note: note.trim() || undefined,
      }),
    onSuccess: async () => {
      reset();
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
    },
  });

  const deactivate = useMutation({
    mutationFn: () => deactivateBreathingSpace(caseId, { note: note.trim() || undefined }),
    onSuccess: async () => {
      reset();
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
    },
  });

  const disabled = status !== 'ACTIVE';
  const pending = activate.isPending || deactivate.isPending;
  const error =
    activate.error instanceof Error
      ? activate.error.message
      : deactivate.error instanceof Error
        ? deactivate.error.message
        : null;

  return (
    <div
      className={`rounded border ${
        active ? 'border-amber-300 bg-amber-50/30' : 'border-border'
      } p-4`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-muted-foreground">Breathing space</h2>
          <p className="text-sm mt-1">
            {active ? (
              <>
                <span className="font-semibold text-amber-700">Active</span>
                <span className="text-muted-foreground">
                  {' '}
                  — chase events suspended, pending tenant drafts auto-rejected, S8 flag
                  suppressed (R7.2).
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">
                Not active. Activate when the tenant has invoked Debt Respite or a
                formal notification has been received.
              </span>
            )}
          </p>
        </div>
        {!open && (
          <button
            type="button"
            className="rounded bg-primary text-primary-foreground px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={disabled || pending}
            onClick={() => setOpen(true)}
          >
            {active ? 'Deactivate…' : 'Activate…'}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-4 border-t border-border pt-4 space-y-3">
          {!active && (
            <label className="block text-sm">
              <span className="text-muted-foreground block mb-1">Source</span>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as BreathingSpaceSource)}
                className="rounded border border-border px-2 py-1 text-sm bg-background"
              >
                <option value="FORMAL_NOTIFICATION">
                  Formal notification (Debt Respite letter)
                </option>
                <option value="TENANT_EMAIL_MENTION">Tenant mention via email</option>
              </select>
            </label>
          )}
          <label className="block text-sm">
            <span className="text-muted-foreground block mb-1">
              Note (optional, max 500 chars)
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 500))}
              rows={2}
              className="w-full rounded border border-border px-2 py-1 text-sm bg-background"
              placeholder={
                active
                  ? 'e.g. moratorium expired'
                  : 'e.g. Debt Respite notification received 19 May'
              }
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {active
              ? 'Deactivating resumes chase from the next tick. Past skipped entries stay skipped (R7.3).'
              : 'Activating cancels pending tenant drafts and clears the S8 flag (R7.2 + R6.6).'}
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={`rounded ${
                active
                  ? 'bg-amber-600 hover:bg-amber-700'
                  : 'bg-primary hover:bg-primary/90'
              } text-primary-foreground px-3 py-1.5 text-sm disabled:opacity-50`}
              disabled={pending}
              onClick={() => (active ? deactivate.mutate() : activate.mutate())}
            >
              {pending
                ? 'Working…'
                : active
                  ? 'Confirm deactivate'
                  : 'Confirm activate'}
            </button>
            <button
              type="button"
              className="rounded border border-border px-3 py-1.5 text-sm"
              disabled={pending}
              onClick={reset}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CommunicationsPlaceholder(): JSX.Element {
  return (
    <div className="border border-border rounded p-4">
      <h2 className="text-sm font-medium text-muted-foreground mb-1">Communications</h2>
      <p className="text-sm text-muted-foreground">
        Inbound + outbound messages will appear here once Phase 5 (digest) and Phase 7
        (inbound) land.
      </p>
    </div>
  );
}

function summarisePayload(p: unknown): string {
  if (p == null) return '';
  try {
    return JSON.stringify(p);
  } catch {
    return '';
  }
}
