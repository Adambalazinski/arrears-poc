import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import {
  createOrganisation,
  listOrganisations,
  storeCredentials,
  type ProbeResult,
  type StoreCredentialResult,
} from '@/lib/api-orgs';

export function OrganisationsListPage(): JSX.Element {
  const auth = useAuth();
  const { data: orgs, isLoading, error } = useQuery({
    queryKey: ['organisations'],
    queryFn: listOrganisations,
  });

  return (
    <main className="min-h-screen bg-background text-foreground">
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

      <section className="px-6 py-6 max-w-4xl mx-auto space-y-8">
        <div>
          <h2 className="text-lg font-semibold mb-3">Configured organisations</h2>
          {isLoading && <p className="text-muted-foreground">Loading…</p>}
          {error && <p className="text-destructive text-sm">Failed to load: {String(error)}</p>}
          {orgs && orgs.length === 0 && (
            <p className="text-muted-foreground">
              No organisations yet. Add one below to start chasing arrears.
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
        </div>

        <AddOrganisationForm />
      </section>
    </main>
  );
}

interface AddFormState {
  id: string;
  name: string;
  accessToken: string;
  refreshToken: string;
}

function AddOrganisationForm(): JSX.Element {
  const qc = useQueryClient();
  const [form, setForm] = useState<AddFormState>({
    id: '',
    name: '',
    accessToken: '',
    refreshToken: '',
  });
  const [probeOutcome, setProbeOutcome] = useState<StoreCredentialResult | null>(null);
  const [genericError, setGenericError] = useState<string | null>(null);
  const [orgCreated, setOrgCreated] = useState<boolean>(false);

  const reset = () => {
    setForm({ id: '', name: '', accessToken: '', refreshToken: '' });
    setProbeOutcome(null);
    setGenericError(null);
    setOrgCreated(false);
  };

  const submit = useMutation({
    mutationFn: async (allowFailedProbe: boolean) => {
      setGenericError(null);
      if (!orgCreated) {
        await createOrganisation({ id: form.id.trim(), name: form.name.trim() });
        setOrgCreated(true);
        await qc.invalidateQueries({ queryKey: ['organisations'] });
      }
      return storeCredentials(form.id.trim(), {
        accessToken: form.accessToken,
        refreshToken: form.refreshToken,
        allowFailedProbe,
      });
    },
    onSuccess: (result) => {
      setProbeOutcome(result);
      if (result.saved) reset();
    },
    onError: (err) => {
      setGenericError(err instanceof Error ? err.message : 'unknown');
    },
  });

  const canSubmit =
    form.id.trim().length > 0 &&
    form.name.trim().length > 0 &&
    form.accessToken.length > 0 &&
    form.refreshToken.length > 0;

  return (
    <div className="border border-border rounded p-4 space-y-4">
      <h2 className="text-lg font-semibold">Add organisation</h2>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="organisationId"
          hint="LWCA upstream organisation id"
          value={form.id}
          onChange={(v) => setForm({ ...form, id: v })}
          disabled={orgCreated}
        />
        <Field
          label="Display name"
          value={form.name}
          onChange={(v) => setForm({ ...form, name: v })}
          disabled={orgCreated}
        />
        <Field
          label="Access token"
          type="password"
          value={form.accessToken}
          onChange={(v) => setForm({ ...form, accessToken: v })}
          className="col-span-2"
        />
        <Field
          label="Refresh token"
          type="password"
          value={form.refreshToken}
          onChange={(v) => setForm({ ...form, refreshToken: v })}
          className="col-span-2"
        />
      </div>

      {genericError && <p className="text-destructive text-sm">{genericError}</p>}

      {probeOutcome && <ProbeDisplay outcome={probeOutcome} />}

      <div className="flex items-center gap-3">
        {!probeOutcome?.probe || probeOutcome.saved ? (
          <button
            type="button"
            className="rounded bg-primary text-primary-foreground px-4 py-2 disabled:opacity-50"
            disabled={!canSubmit || submit.isPending}
            onClick={() => submit.mutate(false)}
          >
            {submit.isPending ? 'Saving…' : 'Create & save credentials'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="rounded bg-destructive text-destructive-foreground px-4 py-2 disabled:opacity-50"
              disabled={submit.isPending}
              onClick={() => submit.mutate(true)}
            >
              Save anyway
            </button>
            <button type="button" className="text-sm underline" onClick={reset}>
              cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field(props: {
  label: string;
  hint?: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <label className={`flex flex-col text-sm gap-1 ${props.className ?? ''}`}>
      <span className="text-muted-foreground">{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        className="border border-input rounded px-2 py-1.5 bg-background disabled:bg-muted disabled:cursor-not-allowed"
      />
      {props.hint && <span className="text-xs text-muted-foreground">{props.hint}</span>}
    </label>
  );
}

function ProbeDisplay({ outcome }: { outcome: StoreCredentialResult }): JSX.Element {
  return (
    <div className="rounded border border-border p-3 space-y-2 bg-muted/30">
      <div className="text-sm">
        <span className="font-medium">Probe:</span>{' '}
        <ProbeBadge status={outcome.probe.overall} />
        {outcome.saved ? (
          <span className="text-xs text-muted-foreground ml-2">credentials saved</span>
        ) : (
          <span className="text-xs text-muted-foreground ml-2">
            {outcome.reason ?? 'not saved'}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <UpstreamCard name="LWCA" upstream={outcome.probe.lwca} />
        <UpstreamCard name="Rentancy" upstream={outcome.probe.rentancy} />
      </div>
    </div>
  );
}

function UpstreamCard({
  name,
  upstream,
}: {
  name: string;
  upstream: ProbeResult['lwca'];
}): JSX.Element {
  return (
    <div className="border border-border rounded p-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-medium">{name}</span>
        <ProbeBadge status={upstream.status} />
      </div>
      <p className="text-xs text-muted-foreground">{upstream.message}</p>
      {upstream.latencyMs > 0 && (
        <p className="text-xs text-muted-foreground">{upstream.latencyMs}ms</p>
      )}
    </div>
  );
}

function ProbeBadge({ status }: { status: string }): JSX.Element {
  const colour =
    status === 'OK'
      ? 'bg-green-600 text-white'
      : status === 'NOT_IMPLEMENTED'
        ? 'bg-yellow-500 text-black'
        : 'bg-destructive text-destructive-foreground';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${colour}`}>
      {status}
    </span>
  );
}
