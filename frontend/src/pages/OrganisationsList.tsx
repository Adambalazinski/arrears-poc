import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AppNav } from '@/components/AppNav';
import { useAuth } from '@/lib/auth';
import { listOrganisations } from '@/lib/api-orgs';

export function OrganisationsListPage(): JSX.Element {
  const auth = useAuth();
  const { data: orgs, isLoading, error } = useQuery({
    queryKey: ['organisations'],
    queryFn: listOrganisations,
  });

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AppNav />
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Arrears POC</h1>
        <div className="text-sm text-muted-foreground flex items-center gap-3">
          <span>
            <code className="font-mono">{auth.user?.email}</code>
          </span>
          <button className="underline" onClick={auth.logout}>
            sign out
          </button>
        </div>
      </header>

      <section className="px-6 py-6 max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Configured organisations</h2>
          <Link
            to="/organisations/new"
            className="rounded bg-primary text-primary-foreground px-3 py-1.5 text-sm"
          >
            + Add organisation
          </Link>
        </div>
        {isLoading && <p className="text-muted-foreground">Loading…</p>}
        {error && <p className="text-destructive text-sm">Failed to load: {String(error)}</p>}
        {orgs && orgs.length === 0 && (
          <p className="text-muted-foreground">
            No organisations yet. Click <span className="font-medium">+ Add organisation</span>{' '}
            to start chasing arrears.
          </p>
        )}
        {orgs && orgs.length > 0 && (
          <ul className="divide-y divide-border border border-border rounded">
            {orgs.map((o) => (
              <li key={o.id} className="px-4 py-3 flex items-center justify-between">
                <div>
                  <div className="font-medium">{o.name}</div>
                  <code className="text-xs text-muted-foreground">{o.id}</code>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <Link
                    to={`/organisations/${encodeURIComponent(o.id)}/cases`}
                    className="underline"
                  >
                    cases →
                  </Link>
                  <Link
                    to={`/organisations/${encodeURIComponent(o.id)}/review-queue`}
                    className="underline"
                  >
                    review queue →
                  </Link>
                  <Link
                    to={`/organisations/${encodeURIComponent(o.id)}/config`}
                    className="underline"
                  >
                    configure →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
