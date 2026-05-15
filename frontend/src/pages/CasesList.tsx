import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import {
  formatPence,
  listCases,
  maxWorkingDaysOverdue,
  mostSevereStage,
  propertyLine,
  syncOrg,
  type CaseRowListed,
  type CaseStatus,
} from '@/lib/api-cases';
import { getOrganisation } from '@/lib/api-orgs';

type StatusFilter = 'ALL' | CaseStatus;
type FlagFilter = 'ANY' | 'S8' | 'BREATHING_SPACE' | 'HANDLER_ACTION';

export function CasesListPage(): JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  if (!orgId) return <p className="p-6">Missing organisation id.</p>;

  const auth = useAuth();
  const qc = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ACTIVE');
  const [flagFilter, setFlagFilter] = useState<FlagFilter>('ANY');

  const org = useQuery({ queryKey: ['org', orgId], queryFn: () => getOrganisation(orgId) });

  const cases = useQuery({
    queryKey: ['cases', orgId, statusFilter],
    queryFn: () => listCases(orgId, statusFilter === 'ALL' ? undefined : statusFilter),
  });

  const sync = useMutation({
    mutationFn: () => syncOrg(orgId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['cases', orgId] });
    },
  });

  const filtered = (cases.data ?? []).filter((c) => matchesFlag(c, flagFilter));

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm underline text-muted-foreground">
            ← organisations
          </Link>
          <div>
            <h1 className="text-xl font-semibold">{org.data?.name ?? orgId}</h1>
            <code className="text-xs text-muted-foreground">{orgId}</code>
          </div>
        </div>
        <div className="text-sm text-muted-foreground flex items-center gap-3">
          <span>
            <code className="font-mono">{auth.user?.email}</code>
          </span>
          <button className="underline" onClick={auth.logout}>
            sign out
          </button>
        </div>
      </header>

      <section className="px-6 py-5 max-w-6xl mx-auto space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm flex items-center gap-2">
            Status
            <select
              className="border border-input rounded px-2 py-1 bg-background"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="ACTIVE">Active</option>
              <option value="CLOSED">Closed</option>
              <option value="ALL">All</option>
            </select>
          </label>
          <label className="text-sm flex items-center gap-2">
            Flag
            <select
              className="border border-input rounded px-2 py-1 bg-background"
              value={flagFilter}
              onChange={(e) => setFlagFilter(e.target.value as FlagFilter)}
            >
              <option value="ANY">Any</option>
              <option value="S8">S8 eligible</option>
              <option value="BREATHING_SPACE">Breathing space</option>
              <option value="HANDLER_ACTION">Awaiting handler</option>
            </select>
          </label>
          <span className="flex-1" />
          <button
            type="button"
            className="rounded bg-primary text-primary-foreground px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {sync.isPending ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        {sync.error && (
          <p className="text-destructive text-sm">
            Sync failed: {sync.error instanceof Error ? sync.error.message : 'unknown'}
          </p>
        )}

        {cases.isLoading && <p className="text-muted-foreground">Loading…</p>}
        {cases.error && (
          <p className="text-destructive text-sm">
            Failed to load: {String(cases.error)}
          </p>
        )}

        {cases.data && filtered.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No cases match the current filters.
          </p>
        )}

        {cases.data && filtered.length > 0 && (
          <div className="border border-border rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <Th>Tenancy</Th>
                  <Th>Property</Th>
                  <Th>Balance</Th>
                  <Th>WD overdue</Th>
                  <Th>Stage</Th>
                  <Th>Flags</Th>
                  <Th>Last synced</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-t border-border hover:bg-muted/30">
                    <Td>
                      <Link
                        to={`/cases/${encodeURIComponent(c.id)}`}
                        className="font-mono text-xs underline"
                      >
                        {c.tenancyId}
                      </Link>
                    </Td>
                    <Td>{propertyLine(c.tenancy)}</Td>
                    <Td>{formatPence(c.lastKnownBalancePence)}</Td>
                    <Td>{maxWorkingDaysOverdue(c.charges)}</Td>
                    <Td>{mostSevereStage(c.charges)}</Td>
                    <Td>
                      <Flags row={c} />
                    </Td>
                    <Td>{fmtRelative(c.lastKnownBalanceAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Th({ children }: { children: React.ReactNode }): JSX.Element {
  return <th className="px-3 py-2 font-medium text-muted-foreground">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }): JSX.Element {
  return <td className="px-3 py-2 align-top">{children}</td>;
}

function Flags({ row }: { row: CaseRowListed }): JSX.Element {
  const items: string[] = [];
  if (row.s8Eligible) items.push('S8');
  if (row.breathingSpaceActive) items.push('BREATHING');
  if (row.awaitingHandlerAction) items.push('HANDLER');
  if (row.status === 'CLOSED') items.push('CLOSED');
  if (items.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex gap-1 flex-wrap">
      {items.map((tag) => (
        <span
          key={tag}
          className="inline-block rounded bg-secondary text-secondary-foreground px-1.5 py-0.5 text-[10px] font-medium"
        >
          {tag}
        </span>
      ))}
    </span>
  );
}

function matchesFlag(c: CaseRowListed, flag: FlagFilter): boolean {
  switch (flag) {
    case 'S8':
      return c.s8Eligible;
    case 'BREATHING_SPACE':
      return c.breathingSpaceActive;
    case 'HANDLER_ACTION':
      return c.awaitingHandlerAction;
    case 'ANY':
    default:
      return true;
  }
}

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}
