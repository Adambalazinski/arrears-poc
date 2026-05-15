import { apiFetch, apiJson } from './api-client';

export interface ReviewQueueListItem {
  id: string;
  organisationId: string;
  caseId: string;
  kind: 'OUTBOUND_DRAFT_APPROVAL' | 'INBOUND_LOW_CONFIDENCE' | 'HARD_TRIGGER_ESCALATION';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  communication: {
    id: string;
    subject: string | null;
    consolidatedStage: string | null;
    toAddress: string | null;
    bodyMarkdown: string | null;
    createdAt: string;
  } | null;
}

export interface ReviewQueueItemDetail extends ReviewQueueListItem {
  communication:
    | (ReviewQueueListItem['communication'] & {
        charges: Array<{
          id: string;
          lwcaInvoiceId: string;
          lastKnownRemainAmountPence: string;
          lastKnownStatus: string;
          dueDate: string;
        }>;
      })
    | null;
}

export interface BalanceChangedResponse {
  message: string | { code: string; detail: BalanceChangedDetail };
  statusCode?: number;
  detail?: BalanceChangedDetail;
}

export interface BalanceChangedDetail {
  draftBalancePence: string;
  currentBalancePence: string;
  perCharge: Array<{
    chargeId: string;
    draftRemainPence: string;
    currentRemainPence: string;
    draftStatus: string;
    currentStatus: string;
    changed: boolean;
  }>;
}

export const listReviewQueue = (organisationId: string) =>
  apiJson<ReviewQueueListItem[]>(
    `/api/review-queue?organisationId=${encodeURIComponent(organisationId)}`,
  );

export const getReviewQueueItem = (id: string) =>
  apiJson<ReviewQueueItemDetail>(`/api/review-queue/${encodeURIComponent(id)}`);

export type ApproveResult =
  | { ok: true }
  | { ok: false; balanceChanged: BalanceChangedDetail };

export async function approveReviewQueueItem(
  id: string,
  editedBodyMarkdown?: string,
): Promise<ApproveResult> {
  const res = await apiFetch(
    `/api/review-queue/${encodeURIComponent(id)}/approve`,
    {
      method: 'POST',
      body: JSON.stringify(editedBodyMarkdown ? { editedBodyMarkdown } : {}),
      headers: { 'Content-Type': 'application/json' },
    },
  );
  if (res.status === 409) {
    const body = (await res.json()) as {
      message: { code: string; detail: BalanceChangedDetail } | string;
    };
    if (typeof body.message === 'object' && body.message.code === 'BALANCE_CHANGED') {
      return { ok: false, balanceChanged: body.message.detail };
    }
    throw new Error(typeof body.message === 'string' ? body.message : 'conflict');
  }
  if (!res.ok) throw new Error(`approve -> HTTP ${res.status}`);
  return { ok: true };
}

export const rejectReviewQueueItem = (id: string, reason: string) =>
  apiJson<{ ok: true }>(`/api/review-queue/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
    headers: { 'Content-Type': 'application/json' },
  });
