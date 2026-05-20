import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { getOrganisation } from '@/lib/api-orgs';
import { createPromise, formatPence } from '@/lib/api-cases';
import {
  approveReviewQueueItem,
  dismissReviewQueueItem,
  getReviewQueueItem,
  listReviewQueue,
  rejectReviewQueueItem,
  type BalanceChangedDetail,
  type ReviewItemKind,
  type ReviewQueueItemDetail,
  type ReviewQueueListItem,
} from '@/lib/api-review-queue';

const PRIORITY_ORDER: ReviewQueueListItem['priority'][] = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];

export function ReviewQueuePage(): JSX.Element {
  const { orgId } = useParams<{ orgId: string }>();
  if (!orgId) return <p className="p-6">Missing organisation id.</p>;

  const auth = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const org = useQuery({ queryKey: ['org', orgId], queryFn: () => getOrganisation(orgId) });
  const items = useQuery({
    queryKey: ['review-queue', orgId],
    queryFn: () => listReviewQueue(orgId),
  });

  const sorted = useMemo(() => {
    if (!items.data) return [];
    return [...items.data].sort((a, b) => {
      const ap = PRIORITY_ORDER.indexOf(a.priority);
      const bp = PRIORITY_ORDER.indexOf(b.priority);
      if (ap !== bp) return ap - bp;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }, [items.data]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm underline text-muted-foreground">
            ← organisations
          </Link>
          <div>
            <h1 className="text-xl font-semibold">Review queue — {org.data?.name ?? orgId}</h1>
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

      <section className="max-w-6xl mx-auto px-6 py-5 grid grid-cols-[320px_1fr] gap-6">
        <div className="border border-border rounded overflow-hidden">
          <header className="bg-muted/40 px-3 py-2 text-sm font-medium text-muted-foreground">
            Pending ({sorted.length})
          </header>
          {items.isLoading && (
            <p className="text-sm text-muted-foreground p-3">Loading…</p>
          )}
          {items.error && (
            <p className="text-sm text-destructive p-3">
              Failed: {String(items.error)}
            </p>
          )}
          {sorted.length === 0 && !items.isLoading && (
            <p className="text-sm text-muted-foreground p-3">
              No pending items. Run the sync + advance the clock to produce drafts.
            </p>
          )}
          <ul className="divide-y divide-border">
            {sorted.map((it) => {
              const direction = it.communication?.direction;
              const counterparty =
                direction === 'INBOUND'
                  ? it.communication?.fromAddress
                  : it.communication?.toAddress;
              const arrow = direction === 'INBOUND' ? '←' : '→';
              return (
                <li
                  key={it.id}
                  className={`px-3 py-2 cursor-pointer hover:bg-muted/30 ${
                    selectedId === it.id ? 'bg-muted/40' : ''
                  }`}
                  onClick={() => setSelectedId(it.id)}
                >
                  <div className="flex items-center justify-between text-xs gap-2">
                    <PriorityBadge priority={it.priority} />
                    <div className="flex items-center gap-1.5">
                      {it.communication?.recipientRole === 'GUARANTOR' && <GuarantorChip />}
                      {it.hasAiRationale && <AiChip />}
                      <KindChip kind={it.kind} />
                    </div>
                  </div>
                  <div className="text-sm mt-1 truncate">
                    {it.communication?.subject ?? '(no subject)'}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 truncate">
                    {arrow} {counterparty ?? '—'}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div>
          {!selectedId && (
            <p className="text-sm text-muted-foreground">
              Select an item on the left to review.
            </p>
          )}
          {selectedId && <ReviewDetail itemId={selectedId} onResolved={() => setSelectedId(null)} />}
        </div>
      </section>
    </main>
  );
}

function KindChip({ kind }: { kind: ReviewItemKind }): JSX.Element {
  const label =
    kind === 'OUTBOUND_DRAFT_APPROVAL'
      ? 'DRAFT'
      : kind === 'INBOUND_LOW_CONFIDENCE'
        ? 'INBOUND'
        : 'ESCALATION';
  const colour =
    kind === 'HARD_TRIGGER_ESCALATION'
      ? 'bg-destructive/15 text-destructive'
      : kind === 'INBOUND_LOW_CONFIDENCE'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
        : 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${colour}`}>
      {label}
    </span>
  );
}

function AiChip(): JSX.Element {
  return (
    <span
      title="AI rationale available"
      className="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold bg-blue-500/15 text-blue-700 dark:text-blue-300"
    >
      AI
    </span>
  );
}

function GuarantorChip(): JSX.Element {
  return (
    <span
      title="Guarantor-track draft"
      className="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/20 text-amber-800 dark:text-amber-300"
    >
      GUARANTOR
    </span>
  );
}

function PriorityBadge({ priority }: { priority: ReviewQueueListItem['priority'] }): JSX.Element {
  const colour =
    priority === 'URGENT'
      ? 'bg-destructive text-destructive-foreground'
      : priority === 'HIGH'
        ? 'bg-orange-500 text-white'
        : priority === 'NORMAL'
          ? 'bg-secondary text-secondary-foreground'
          : 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${colour}`}>
      {priority}
    </span>
  );
}

function ReviewDetail({
  itemId,
  onResolved,
}: {
  itemId: string;
  onResolved: () => void;
}): JSX.Element {
  const detail = useQuery({
    queryKey: ['review-queue-item', itemId],
    queryFn: () => getReviewQueueItem(itemId),
  });

  if (detail.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (detail.error || !detail.data) {
    return (
      <p className="text-sm text-destructive">
        Failed: {detail.error instanceof Error ? detail.error.message : 'unknown'}
      </p>
    );
  }
  const it = detail.data;

  return (
    <div className="space-y-4">
      <DetailHeader it={it} />
      {it.kind === 'OUTBOUND_DRAFT_APPROVAL' ? (
        <OutboundDraftPanel it={it} onResolved={onResolved} />
      ) : (
        <InboundReviewPanel it={it} onResolved={onResolved} />
      )}
    </div>
  );
}

function DetailHeader({ it }: { it: ReviewQueueItemDetail }): JSX.Element {
  const comm = it.communication;
  const isInbound = it.kind !== 'OUTBOUND_DRAFT_APPROVAL';
  return (
    <div className="border border-border rounded p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">{comm?.subject ?? '(no subject)'}</h2>
        <div className="flex items-center gap-2">
          {it.communication?.recipientRole === 'GUARANTOR' && <GuarantorChip />}
          {it.hasAiRationale && <AiChip />}
          <KindChip kind={it.kind} />
          <PriorityBadge priority={it.priority} />
        </div>
      </div>
      <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-xs">
        <dt className="text-muted-foreground">Case</dt>
        <dd>
          <Link
            to={`/cases/${encodeURIComponent(it.caseId)}`}
            className="font-mono underline"
          >
            {it.caseId}
          </Link>
        </dd>
        {isInbound ? (
          <>
            <dt className="text-muted-foreground">From</dt>
            <dd>{comm?.fromAddress ?? '—'}</dd>
            <dt className="text-muted-foreground">Received</dt>
            <dd>
              {it.inbound?.receivedAt
                ? new Date(it.inbound.receivedAt).toLocaleString('en-GB')
                : '—'}
            </dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">Recipient</dt>
            <dd>{comm?.toAddress ?? '—'}</dd>
            <dt className="text-muted-foreground">Stage</dt>
            <dd>{comm?.consolidatedStage ?? '—'}</dd>
            <dt className="text-muted-foreground">Drafted</dt>
            <dd>{comm ? new Date(comm.createdAt).toLocaleString('en-GB') : '—'}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function ClassificationPanel({
  classification,
}: {
  classification: NonNullable<ReviewQueueItemDetail['classification']>;
}): JSX.Element {
  if (classification.preFilterMatched) {
    return (
      <div className="border border-destructive/40 bg-destructive/5 rounded p-4 text-sm space-y-1">
        <h3 className="font-medium text-destructive">Hard-trigger pre-filter match</h3>
        <p>
          Trigger: <code className="font-mono">{classification.preFilterTriggerKind}</code>
        </p>
        <p>
          Keyword matched:{' '}
          <code className="font-mono">{classification.preFilterMatchedKeyword}</code>
        </p>
        <p className="text-xs text-muted-foreground">
          The LLM was deliberately not invoked — this message bypassed
          classification and was routed to the URGENT queue. Action this
          escalation outside the system, then dismiss.
        </p>
      </div>
    );
  }
  return (
    <div className="border border-blue-500/30 bg-blue-500/5 rounded p-4 text-sm space-y-2">
      <h3 className="font-medium">AI classification</h3>
      <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-xs">
        <dt className="text-muted-foreground">Model</dt>
        <dd className="font-mono">{classification.modelUsed ?? '—'}</dd>
        <dt className="text-muted-foreground">Sentiment</dt>
        <dd>{classification.sentiment ?? '—'}</dd>
        <dt className="text-muted-foreground">Intent</dt>
        <dd>{classification.intent ?? '—'}</dd>
        <dt className="text-muted-foreground">Confidence</dt>
        <dd>
          {classification.confidence !== null
            ? `${(Number(classification.confidence) * 100).toFixed(0)}%`
            : '—'}
        </dd>
        <dt className="text-muted-foreground">Cost</dt>
        <dd>
          {classification.estimatedCostPence !== null
            ? `${classification.estimatedCostPence}p (${classification.promptTokens ?? 0}+${classification.completionTokens ?? 0} tokens)`
            : '—'}
        </dd>
      </dl>
      {classification.rationale && (
        <p className="text-xs italic text-muted-foreground">“{classification.rationale}”</p>
      )}
    </div>
  );
}

function InboundOriginalPanel({
  inbound,
}: {
  inbound: NonNullable<ReviewQueueItemDetail['inbound']>;
}): JSX.Element {
  return (
    <div className="border border-border rounded p-4">
      <h3 className="text-sm font-medium text-muted-foreground mb-2">
        Original inbound message
      </h3>
      <pre className="whitespace-pre-wrap font-mono text-xs">
        {inbound.rawBodyText ?? '(no body)'}
      </pre>
    </div>
  );
}

function PaymentPromisePanel({
  caseId,
  sourceInboundCommunicationId,
}: {
  caseId: string;
  sourceInboundCommunicationId: string;
}): JSX.Element {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const defaultDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const [promiseDate, setPromiseDate] = useState(defaultDate);
  const [note, setNote] = useState('');
  const [created, setCreated] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createPromise(caseId, {
        promiseDate: new Date(promiseDate).toISOString(),
        note: note.trim() || undefined,
        sourceInboundCommunicationId,
      }),
    onSuccess: async (r) => {
      setCreated(r.promise.id);
      setOpen(false);
      setNote('');
      // Refresh the case detail (cascade may have auto-rejected other
      // drafts on this case) and the review queue (this item's status
      // is unchanged — handler still owns the draft-reply decision).
      await qc.invalidateQueries({ queryKey: ['case', caseId] });
      await qc.invalidateQueries({ queryKey: ['review-queue'] });
    },
  });

  return (
    <div className="border border-emerald-400 bg-emerald-50/30 rounded p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-emerald-800">
            AI detected a payment promise
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Classifier flagged intent=PAYMENT_PROMISE. Log this as a formal promise to
            pause chase events until the date the tenant gave (R10). Replying to the
            tenant is a separate decision — handle the draft below as usual.
          </p>
        </div>
        {!open && !created && (
          <button
            type="button"
            className="rounded bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-sm"
            onClick={() => setOpen(true)}
          >
            Log promise…
          </button>
        )}
      </div>
      {open && (
        <div className="mt-4 border-t border-emerald-200 pt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-muted-foreground block mb-1">Promise date</span>
            <input
              type="date"
              value={promiseDate}
              onChange={(e) => setPromiseDate(e.target.value)}
              className="rounded border border-border px-2 py-1 text-sm bg-background"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground block mb-1">Note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 500))}
              rows={2}
              className="w-full rounded border border-border px-2 py-1 text-sm bg-background"
              placeholder='e.g. acknowledges in their reply: "will pay Friday"'
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Pauses both tenant and guarantor chase entries until the promise date.
            Pending drafts on this case will be auto-rejected. Date must be within 15
            days; max two promises per case in any 30-day window.
          </p>
          {create.error && (
            <p className="text-sm text-destructive">
              {create.error instanceof Error ? create.error.message : 'failed'}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-sm disabled:opacity-50"
              disabled={create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Logging…' : 'Confirm'}
            </button>
            <button
              type="button"
              className="rounded border border-border px-3 py-1.5 text-sm"
              disabled={create.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {created && (
        <p className="mt-3 text-sm text-emerald-700">
          Promise logged. The promise card on the case detail now reflects the active
          status; this review item is unchanged.
        </p>
      )}
    </div>
  );
}

function OutboundDraftPanel({
  it,
  onResolved,
}: {
  it: ReviewQueueItemDetail;
  onResolved: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const comm = it.communication;
  const [edit, setEdit] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [balanceChanged, setBalanceChanged] = useState<BalanceChangedDetail | null>(null);

  const approve = useMutation({
    mutationFn: () => approveReviewQueueItem(it.id, edit ?? undefined),
    onSuccess: async (r) => {
      if (!r.ok) {
        setBalanceChanged(r.balanceChanged);
        return;
      }
      await qc.invalidateQueries({ queryKey: ['review-queue'] });
      onResolved();
    },
  });

  const reject = useMutation({
    mutationFn: () => rejectReviewQueueItem(it.id, rejectReason.trim()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['review-queue'] });
      onResolved();
    },
  });

  return (
    <>
      {it.classification && <ClassificationPanel classification={it.classification} />}
      {it.inbound && <InboundOriginalPanel inbound={it.inbound} />}
      {it.classification?.intent === 'PAYMENT_PROMISE' && it.inbound && (
        <PaymentPromisePanel
          caseId={it.caseId}
          sourceInboundCommunicationId={it.inbound.id}
        />
      )}

      <div className="border border-border rounded p-4">
        <h3 className="text-sm font-medium text-muted-foreground mb-2">Draft reply</h3>
        {edit !== null ? (
          <textarea
            rows={20}
            className="w-full border border-input rounded px-2 py-1.5 bg-background font-mono text-xs"
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
          />
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-xs">
            {comm?.bodyMarkdown ?? '(no body)'}
          </pre>
        )}
      </div>

      {comm?.charges && comm.charges.length > 0 && (
        <div className="border border-border rounded p-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">Linked charges</h3>
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1">Invoice</th>
                <th className="py-1">Due</th>
                <th className="py-1">Remain</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {comm.charges.map((ch) => (
                <tr key={ch.id} className="border-t border-border">
                  <td className="py-1 font-mono">{ch.lwcaInvoiceId}</td>
                  <td className="py-1">{new Date(ch.dueDate).toLocaleDateString('en-GB')}</td>
                  <td className="py-1">{formatPence(ch.lastKnownRemainAmountPence)}</td>
                  <td className="py-1">{ch.lastKnownStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {balanceChanged && (
        <BalanceChangedNotice
          detail={balanceChanged}
          onDismiss={() => setBalanceChanged(null)}
        />
      )}

      <div className="flex items-center gap-3">
        {edit === null ? (
          <>
            <button
              type="button"
              className="rounded bg-primary text-primary-foreground px-3 py-1.5 disabled:opacity-50"
              disabled={approve.isPending}
              onClick={() => approve.mutate()}
            >
              {approve.isPending ? 'Approving…' : 'Approve'}
            </button>
            <button
              type="button"
              className="rounded border border-input px-3 py-1.5 text-sm"
              onClick={() => setEdit(comm?.bodyMarkdown ?? '')}
            >
              Edit
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="rounded bg-primary text-primary-foreground px-3 py-1.5 disabled:opacity-50"
              disabled={approve.isPending}
              onClick={() => approve.mutate()}
            >
              {approve.isPending ? 'Saving…' : 'Save & approve'}
            </button>
            <button
              type="button"
              className="rounded border border-input px-3 py-1.5 text-sm"
              onClick={() => setEdit(null)}
            >
              Cancel edit
            </button>
          </>
        )}
        <span className="flex-1" />
        <input
          type="text"
          placeholder="reject reason"
          className="border border-input rounded px-2 py-1.5 text-sm bg-background"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
        />
        <button
          type="button"
          className="rounded bg-destructive text-destructive-foreground px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={!rejectReason.trim() || reject.isPending}
          onClick={() => reject.mutate()}
        >
          {reject.isPending ? 'Rejecting…' : 'Reject'}
        </button>
      </div>

      {approve.error && (
        <p className="text-destructive text-sm">
          {approve.error instanceof Error ? approve.error.message : 'approve failed'}
        </p>
      )}
      {reject.error && (
        <p className="text-destructive text-sm">
          {reject.error instanceof Error ? reject.error.message : 'reject failed'}
        </p>
      )}
    </>
  );
}

function InboundReviewPanel({
  it,
  onResolved,
}: {
  it: ReviewQueueItemDetail;
  onResolved: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [note, setNote] = useState('');

  const dismiss = useMutation({
    mutationFn: () =>
      dismissReviewQueueItem(it.id, note.trim() ? note.trim() : undefined),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['review-queue'] });
      onResolved();
    },
  });

  return (
    <>
      {it.classification && <ClassificationPanel classification={it.classification} />}
      {it.inbound && <InboundOriginalPanel inbound={it.inbound} />}

      <div className="border border-border rounded p-4 space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Handler action</h3>
        <p className="text-xs text-muted-foreground">
          {it.kind === 'HARD_TRIGGER_ESCALATION'
            ? 'This message hit a hard-trigger pre-filter. Handle the escalation outside the system (phone call, in-person, manual email), then dismiss.'
            : 'AI could not auto-draft a reply. Handle the message outside the system and dismiss when done.'}
        </p>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="optional note (e.g., what you did)"
            className="flex-1 border border-input rounded px-2 py-1.5 text-sm bg-background"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            type="button"
            className="rounded bg-primary text-primary-foreground px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate()}
          >
            {dismiss.isPending ? 'Dismissing…' : 'Dismiss'}
          </button>
        </div>
        {dismiss.error && (
          <p className="text-destructive text-sm">
            {dismiss.error instanceof Error ? dismiss.error.message : 'dismiss failed'}
          </p>
        )}
      </div>
    </>
  );
}

function BalanceChangedNotice({
  detail,
  onDismiss,
}: {
  detail: BalanceChangedDetail;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div className="border border-destructive/40 bg-destructive/10 text-destructive rounded p-3 text-sm space-y-2">
      <div className="flex items-center justify-between">
        <strong>Balance changed since draft</strong>
        <button
          type="button"
          className="text-xs underline"
          onClick={onDismiss}
        >
          dismiss
        </button>
      </div>
      <p>
        Draft balance: {formatPence(detail.draftBalancePence)} → current{' '}
        {formatPence(detail.currentBalancePence)}.
      </p>
      <ul className="list-disc pl-5 text-xs">
        {detail.perCharge
          .filter((c) => c.changed)
          .map((c) => (
            <li key={c.chargeId}>
              <code>{c.chargeId}</code>: {formatPence(c.draftRemainPence)} (
              {c.draftStatus}) → {formatPence(c.currentRemainPence)} ({c.currentStatus})
            </li>
          ))}
      </ul>
      <p className="text-xs">
        Reject this draft and run a fresh sync / advance-clock to regenerate against current
        state. (Auto-regenerate button arrives with Phase 6.)
      </p>
    </div>
  );
}
