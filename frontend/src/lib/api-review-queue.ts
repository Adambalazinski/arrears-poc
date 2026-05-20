import { apiFetch, apiJson } from './api-client';

export type ReviewItemKind =
  | 'OUTBOUND_DRAFT_APPROVAL'
  | 'INBOUND_LOW_CONFIDENCE'
  | 'HARD_TRIGGER_ESCALATION';

export type CommunicationDirection = 'INBOUND' | 'OUTBOUND';

export interface ReviewQueueListItem {
  id: string;
  organisationId: string;
  caseId: string;
  kind: ReviewItemKind;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  hasAiRationale: boolean;
  communication: {
    id: string;
    direction: CommunicationDirection;
    recipientRole: 'TENANT' | 'GUARANTOR' | null;
    subject: string | null;
    consolidatedStage: string | null;
    toAddress: string | null;
    fromAddress: string | null;
    bodyMarkdown: string | null;
    createdAt: string;
  } | null;
}

export interface ReviewQueueItemDetail extends ReviewQueueListItem {
  communication:
    | (ReviewQueueListItem['communication'] & {
        rawBodyText: string | null;
        charges: Array<{
          id: string;
          lwcaInvoiceId: string;
          lastKnownRemainAmountPence: string;
          lastKnownStatus: string;
          dueDate: string;
        }>;
      })
    | null;
  classification: {
    id: string;
    preFilterMatched: boolean;
    preFilterTriggerKind: string | null;
    preFilterMatchedKeyword: string | null;
    modelUsed: string | null;
    sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'DISTRESSED' | null;
    intent:
      | 'PAYMENT_PROMISE'
      | 'PAYMENT_CONFIRMATION'
      | 'QUERY'
      | 'COMPLAINT'
      | 'REQUEST_FOR_INFO'
      | 'UNCLEAR'
      | null;
    confidence: string | null;
    rationale: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    estimatedCostPence: number | null;
  } | null;
  inbound: {
    id: string;
    subject: string | null;
    fromAddress: string | null;
    rawBodyText: string | null;
    receivedAt: string | null;
  } | null;
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

export const dismissReviewQueueItem = (id: string, note?: string) =>
  apiJson<{ ok: true }>(`/api/review-queue/${encodeURIComponent(id)}/dismiss`, {
    method: 'POST',
    body: JSON.stringify(note ? { note } : {}),
    headers: { 'Content-Type': 'application/json' },
  });
