import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppNav } from '@/components/AppNav';
import {
  getCredentials,
  getOrgConfig,
  getOrganisation,
  patchOrgConfig,
  storeCredentials,
  type CredentialSummary,
  type OrganisationConfig,
} from '@/lib/api-orgs';

export function OrganisationConfigPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  if (!id) return <p className="p-6">Missing organisation id in URL.</p>;

  const org = useQuery({ queryKey: ['org', id], queryFn: () => getOrganisation(id) });
  const config = useQuery({ queryKey: ['org-config', id], queryFn: () => getOrgConfig(id) });
  const creds = useQuery({ queryKey: ['org-creds', id], queryFn: () => getCredentials(id) });

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AppNav orgId={id} />
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{org.data?.name ?? id}</h1>
          <code className="text-xs text-muted-foreground">{id}</code>
        </div>
      </header>

      <section className="px-6 py-6 max-w-4xl mx-auto space-y-8">
        {config.data && <ConfigForm id={id} initial={config.data} />}
        {config.isLoading && <p className="text-muted-foreground">Loading config…</p>}
        <CredentialsCard id={id} summary={creds.data ?? null} loading={creds.isLoading} />
      </section>
    </main>
  );
}

function ConfigForm({ id, initial }: { id: string; initial: OrganisationConfig }): JSX.Element {
  const qc = useQueryClient();
  const [form, setForm] = useState<OrganisationConfig>(initial);
  const [saved, setSaved] = useState<boolean>(false);

  useEffect(() => setForm(initial), [initial]);

  const save = useMutation({
    mutationFn: async () => {
      const patch: Partial<OrganisationConfig> = computePatch(initial, form);
      return patchOrgConfig(id, patch);
    },
    onSuccess: async (updated) => {
      setForm(updated);
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ['org-config', id] });
      setTimeout(() => setSaved(false), 2500);
    },
  });

  return (
    <form
      className="border border-border rounded p-4 space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="text-lg font-semibold">Configuration</h2>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-muted-foreground">
          Chase cadence (working days)
        </legend>
        <div className="grid grid-cols-4 gap-3">
          <NumberField
            label="WD3"
            value={form.chaseDayFirst}
            onChange={(v) => setForm({ ...form, chaseDayFirst: v })}
          />
          <NumberField
            label="WD5"
            value={form.chaseDaySecond}
            onChange={(v) => setForm({ ...form, chaseDaySecond: v })}
          />
          <NumberField
            label="WD8"
            value={form.chaseDayThird}
            onChange={(v) => setForm({ ...form, chaseDayThird: v })}
          />
          <NumberField
            label="WD14"
            value={form.chaseDayExecNotify}
            onChange={(v) => setForm({ ...form, chaseDayExecNotify: v })}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-muted-foreground">S8 threshold</legend>
        <div className="grid grid-cols-2 gap-3">
          <SliderField
            label={`${form.s8RentMonthsThreshold} months`}
            min={1}
            max={12}
            value={form.s8RentMonthsThreshold}
            onChange={(v) => setForm({ ...form, s8RentMonthsThreshold: v })}
          />
          <SliderField
            label={`${form.s8WeeksThreshold} weeks`}
            min={1}
            max={52}
            value={form.s8WeeksThreshold}
            onChange={(v) => setForm({ ...form, s8WeeksThreshold: v })}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-muted-foreground">Polling & AI</legend>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Polling interval (minutes)"
            value={form.pollingIntervalMinutes}
            onChange={(v) => setForm({ ...form, pollingIntervalMinutes: v })}
          />
          <SliderField
            label={`AI confidence threshold: ${form.aiConfidenceThreshold}`}
            min={0}
            max={1}
            step={0.05}
            value={Number(form.aiConfidenceThreshold)}
            onChange={(v) => setForm({ ...form, aiConfidenceThreshold: v.toFixed(2) })}
          />
          <Field
            label="Classification model"
            value={form.aiClassificationModel}
            onChange={(v) => setForm({ ...form, aiClassificationModel: v })}
          />
          <Field
            label="Draft model"
            value={form.aiDraftModel}
            onChange={(v) => setForm({ ...form, aiDraftModel: v })}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.autoSendEnabled}
            onChange={(e) => setForm({ ...form, autoSendEnabled: e.target.checked })}
          />
          <span>Auto-send enabled (POC: must stay off)</span>
        </label>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-muted-foreground">Chase templates</legend>
        <TemplateField
          label="WD3 tenant"
          value={form.templateWd3Tenant}
          onChange={(v) => setForm({ ...form, templateWd3Tenant: v })}
        />
        <TemplateField
          label="WD5 tenant"
          value={form.templateWd5Tenant}
          onChange={(v) => setForm({ ...form, templateWd5Tenant: v })}
        />
        <TemplateField
          label="WD8 tenant"
          value={form.templateWd8Tenant}
          onChange={(v) => setForm({ ...form, templateWd8Tenant: v })}
        />
        <TemplateField
          label="WD14 tenant"
          value={form.templateWd14Tenant}
          onChange={(v) => setForm({ ...form, templateWd14Tenant: v })}
        />
        <TemplateField
          label="Broken promise"
          value={form.templateBrokenPromise}
          onChange={(v) => setForm({ ...form, templateBrokenPromise: v })}
        />
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded bg-primary text-primary-foreground px-4 py-2 disabled:opacity-50"
          disabled={save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save configuration'}
        </button>
        {saved && <span className="text-sm text-green-700">saved</span>}
        {save.error && (
          <span className="text-sm text-destructive">
            failed: {save.error instanceof Error ? save.error.message : 'unknown'}
          </span>
        )}
      </div>
    </form>
  );
}

function CredentialsCard({
  id,
  summary,
  loading,
}: {
  id: string;
  summary: CredentialSummary | null;
  loading: boolean;
}): JSX.Element {
  const [rotating, setRotating] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const qc = useQueryClient();

  const rotate = useMutation({
    mutationFn: () =>
      storeCredentials(id, {
        accessToken,
        refreshToken,
        allowFailedProbe: true,
      }),
    onSuccess: async () => {
      setRotating(false);
      setAccessToken('');
      setRefreshToken('');
      await qc.invalidateQueries({ queryKey: ['org-creds', id] });
    },
  });

  return (
    <div className="border border-border rounded p-4 space-y-3">
      <h2 className="text-lg font-semibold">Upstream credentials</h2>
      {loading && <p className="text-muted-foreground">Loading…</p>}
      {!loading && !summary && (
        <p className="text-muted-foreground text-sm">No credentials stored.</p>
      )}
      {summary && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Row label="Backend" value={summary.storageBackend} />
          <Row label="Access token" value={summary.accessTokenMask ?? '—'} mono />
          <Row label="Refresh token" value={summary.refreshTokenMask ?? '—'} mono />
          <Row label="Access expires" value={fmtDate(summary.accessTokenExpiresAt)} />
          <Row label="Refresh expires" value={fmtDate(summary.refreshTokenExpiresAt)} />
          <Row label="Created" value={fmtDate(summary.createdAt)} />
          <Row label="Last used" value={fmtDate(summary.lastUsedAt)} />
          <Row label="Last rotated" value={fmtDate(summary.rotatedAt)} />
        </dl>
      )}

      {!rotating && (
        <button
          type="button"
          className="text-sm underline"
          onClick={() => setRotating(true)}
        >
          rotate credentials
        </button>
      )}

      {rotating && (
        <div className="space-y-2 border-t border-border pt-3">
          <Field
            label="New access token"
            type="password"
            value={accessToken}
            onChange={setAccessToken}
          />
          <Field
            label="New refresh token"
            type="password"
            value={refreshToken}
            onChange={setRefreshToken}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="rounded bg-primary text-primary-foreground px-4 py-2 disabled:opacity-50"
              disabled={!accessToken || !refreshToken || rotate.isPending}
              onClick={() => rotate.mutate()}
            >
              {rotate.isPending ? 'Saving…' : 'Save rotation'}
            </button>
            <button
              type="button"
              className="text-sm underline"
              onClick={() => {
                setRotating(false);
                setAccessToken('');
                setRefreshToken('');
              }}
            >
              cancel
            </button>
          </div>
          {rotate.error && (
            <p className="text-sm text-destructive">
              failed: {rotate.error instanceof Error ? rotate.error.message : 'unknown'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono' : ''}>{value}</dd>
    </>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label className="flex flex-col text-sm gap-1">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="border border-input rounded px-2 py-1.5 bg-background"
      />
    </label>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label className="flex flex-col text-sm gap-1">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </label>
  );
}

function Field(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="flex flex-col text-sm gap-1">
      <span className="text-muted-foreground">{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="border border-input rounded px-2 py-1.5 bg-background"
      />
    </label>
  );
}

function TemplateField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="flex flex-col text-sm gap-1">
      <span className="text-muted-foreground">{props.label}</span>
      <textarea
        rows={5}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="border border-input rounded px-2 py-1.5 bg-background font-mono text-xs"
      />
    </label>
  );
}

function computePatch(
  initial: OrganisationConfig,
  current: OrganisationConfig,
): Partial<OrganisationConfig> {
  const patch: Partial<OrganisationConfig> = {};
  for (const k of Object.keys(current) as (keyof OrganisationConfig)[]) {
    if (k === 'organisationId') continue;
    const a = initial[k];
    const b = current[k];
    if (a !== b) (patch as Record<string, unknown>)[k] = b;
  }
  return patch;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  return new Date(s).toLocaleString('en-GB');
}
