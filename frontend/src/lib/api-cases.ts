import { apiJson } from './api-client';

export type CaseStatus = 'ACTIVE' | 'CLOSED';

export type ChaseStage =
  | 'NOT_DUE'
  | 'AWAITING_WD3'
  | 'WD3_SENT'
  | 'AWAITING_WD5'
  | 'WD5_SENT'
  | 'AWAITING_WD8'
  | 'WD8_SENT'
  | 'AWAITING_WD14'
  | 'WD14_NOTIFIED'
  | 'RESOLVED';

export type ChargeStatus =
  | 'UNPAID'
  | 'PARTIALLY_PAID'
  | 'PARTIALLY_RECONCILED'
  | 'PAID'
  | 'RECONCILED'
  | 'DELETED'
  | 'PAYMENT_PROCESSING';

export type TenancyStatus = 'ACTIVE' | 'ENDED' | 'UNKNOWN';

export interface TenancyRow {
  id: string;
  organisationId: string;
  propertyId: string;
  propertyName: string | null;
  propertyAddress1: string | null;
  propertyAddress2: string | null;
  reference: string | null;
  rentDayOfMonth: number | null;
  /** BigInt pence serialised as string. */
  rentAmountPence: string | null;
  status: TenancyStatus;
  lastSyncedAt: string;
}

export interface ChargeRowSummary {
  id: string;
  lwcaInvoiceId: string;
  currentStage: ChaseStage;
  workingDaysOverdue: number;
  lastKnownStatus: ChargeStatus;
  lastKnownRemainAmountPence: string;
  grossAmountPence: string;
  dueDate: string;
  lastSyncedAt: string;
}

export interface CaseRowListed {
  id: string;
  organisationId: string;
  tenancyId: string;
  status: CaseStatus;
  openedAt: string;
  closedAt: string | null;
  lastKnownBalancePence: string;
  lastKnownBalanceAt: string;
  s8Eligible: boolean;
  breathingSpaceActive: boolean;
  awaitingHandlerAction: boolean;
  /** Explicitly assigned handler. null when no one's claimed the case. */
  handlerUserId: string | null;
  /** Fallback: actor on the most recent CaseEvent with a non-null actorUserId. */
  lastActorUserId: string | null;
  lastActorAt: string | null;
  createdAt: string;
  updatedAt: string;
  tenancy: TenancyRow & { tenancyContacts: TenancyContactRow[] };
  charges: ChargeRowSummary[];
}

export const setHandler = (caseId: string, handlerUserId: string | null) =>
  apiJson<{ caseId: string; handlerUserId: string | null }>(
    `/api/cases/${encodeURIComponent(caseId)}/handler`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handlerUserId }),
    },
  );

/** Returns a short display string for the tenants on a tenancy (max 2 names listed). */
export function formatTenants(tenancyContacts: TenancyContactRow[]): string {
  const tenants = tenancyContacts.filter((tc) => tc.role === 'TENANT');
  if (tenants.length === 0) return '—';
  const names = tenants.map((tc) => contactDisplayName(tc.contact));
  if (names.length <= 2) return names.join(', ');
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

function contactDisplayName(c: ContactRow): string {
  if (c.companyName) return c.companyName;
  const first = c.firstName?.trim() ?? '';
  const last = c.lastName?.trim() ?? '';
  const joined = `${first} ${last}`.trim();
  return joined || c.primaryEmail || '(unnamed)';
}

export interface ContactRow {
  id: string;
  organisationId: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  primaryEmail: string | null;
}

export interface TenancyContactRow {
  tenancyId: string;
  contactId: string;
  role: 'TENANT' | 'GUARANTOR';
  contact: ContactRow;
}

export interface CaseEventRow {
  id: string;
  caseId: string;
  kind: string;
  payloadJson: unknown;
  actorUserId: string | null;
  occurredAt: string;
}

export interface ChargeRowDetail extends ChargeRowSummary {
  caseId: string;
  organisationId: string;
  invoiceDate: string;
  currentStageEnteredAt: string | null;
  lastKnownPaymentCycleType: string | null;
  lastKnownType: string | null;
  lastKnownDescription: string | null;
}

export type EscalationFlagKind =
  | 'S8_ELIGIBLE'
  | 'BREATHING_SPACE'
  | 'HARDSHIP_INDICATED'
  | 'MENTAL_HEALTH_INDICATED'
  | 'THIRD_PARTY_INVOLVED'
  | 'LIABILITY_DISPUTED'
  | 'DOMESTIC_CIRCUMSTANCES'
  | 'AI_CONFIDENCE_FAILURE'
  | 'STALE_BALANCE_60D'
  | 'REPEATED_SMALL_PAYMENTS';

export interface EscalationFlagRow {
  id: string;
  caseId: string;
  kind: EscalationFlagKind;
  raisedAt: string;
  raisedReason: string;
  resolvedAt: string | null;
  resolvedReason: string | null;
  payloadJson: unknown;
}

export type PromiseStatus = 'ACTIVE' | 'FULFILLED' | 'BROKEN' | 'CANCELLED';

export interface PromiseRow {
  id: string;
  caseId: string;
  status: PromiseStatus;
  promiseDate: string;
  note: string | null;
  createdAt: string;
  createdByUserId: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  resolutionNote: string | null;
  sourceInboundCommunicationId: string | null;
  updatedAt: string;
}

export type CommunicationDirection = 'INBOUND' | 'OUTBOUND';
export type CommunicationStatus =
  | 'DRAFT'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'SENT'
  | 'REJECTED'
  | 'AUTO_REJECTED'
  | 'PROCESSED'
  | 'FAILED';

export interface CommunicationSummary {
  id: string;
  direction: CommunicationDirection;
  channel: 'EMAIL' | 'WHATSAPP';
  status: CommunicationStatus;
  recipientRole: 'TENANT' | 'GUARANTOR' | null;
  consolidatedStage: ChaseStage | null;
  toAddress: string | null;
  fromAddress: string | null;
  subject: string | null;
  bodyMarkdown: string | null;
  rawBodyText: string | null;
  receivedAt: string | null;
  sentAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  draftedByAi: boolean;
}

export interface CaseRowDetail extends Omit<CaseRowListed, 'charges' | 'tenancy'> {
  tenancy: TenancyRow & { tenancyContacts: TenancyContactRow[] };
  charges: ChargeRowDetail[];
  events: CaseEventRow[];
  escalationFlags: EscalationFlagRow[];
  promises: PromiseRow[];
  communications: CommunicationSummary[];
}

export const listCases = (orgId: string, status?: CaseStatus) => {
  const qs = status ? `?status=${status}` : '';
  return apiJson<CaseRowListed[]>(
    `/api/organisations/${encodeURIComponent(orgId)}/cases${qs}`,
  );
};

export const getCase = (id: string) =>
  apiJson<CaseRowDetail>(`/api/cases/${encodeURIComponent(id)}`);

export const syncOrg = (orgId: string) =>
  apiJson<unknown>(`/api/organisations/${encodeURIComponent(orgId)}/sync`, {
    method: 'POST',
  });

export interface ResetDemoResult {
  organisationId: string;
  deleted: Record<string, number>;
  resync: {
    organisationId: string;
    casesOpened: number;
    casesClosed: number;
    processed: number;
    created: number;
    updated: number;
    status: string;
  };
}

export const resetDemo = (orgId: string) =>
  apiJson<ResetDemoResult>(`/api/dev/reset-demo/${encodeURIComponent(orgId)}`, {
    method: 'POST',
  });

export const refreshCase = (id: string) =>
  apiJson<unknown>(`/api/cases/${encodeURIComponent(id)}/refresh`, {
    method: 'POST',
  });

export type BreathingSpaceSource = 'FORMAL_NOTIFICATION' | 'TENANT_EMAIL_MENTION';

export interface BreathingSpaceToggleResult {
  caseId: string;
  breathingSpaceActive: boolean;
  changed: boolean;
  chaseEntriesSkipped: number;
  draftsAutoRejected: number;
}

export const activateBreathingSpace = (
  caseId: string,
  input: { source: BreathingSpaceSource; note?: string },
) =>
  apiJson<BreathingSpaceToggleResult>(
    `/api/cases/${encodeURIComponent(caseId)}/breathing-space/activate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );

export const deactivateBreathingSpace = (caseId: string, input: { note?: string } = {}) =>
  apiJson<BreathingSpaceToggleResult>(
    `/api/cases/${encodeURIComponent(caseId)}/breathing-space/deactivate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );

export interface CreatePromiseInput {
  promiseDate: string;
  note?: string;
  sourceInboundCommunicationId?: string;
}

export interface CreatePromiseResult {
  promise: PromiseRow;
  chaseEntriesSkipped: number;
  draftsAutoRejected: number;
}

export const createPromise = (caseId: string, input: CreatePromiseInput) =>
  apiJson<CreatePromiseResult>(`/api/cases/${encodeURIComponent(caseId)}/promises`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

export const fulfillPromise = (promiseId: string, note?: string) =>
  apiJson<PromiseRow>(`/api/promises/${encodeURIComponent(promiseId)}/fulfill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(note ? { note } : {}),
  });

export const cancelPromise = (promiseId: string, note?: string) =>
  apiJson<PromiseRow>(`/api/promises/${encodeURIComponent(promiseId)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(note ? { note } : {}),
  });

/** Pull tenant display name from the linked Rentancy contacts on a case detail. */
export function tenantNameFromDetail(detail: CaseRowDetail): string {
  const tenant = detail.tenancy.tenancyContacts.find((tc) => tc.role === 'TENANT')?.contact;
  if (!tenant) return '—';
  return [tenant.firstName, tenant.lastName].filter(Boolean).join(' ') || '—';
}

export function propertyLine(t: TenancyRow): string {
  return [t.propertyName, t.propertyAddress1, t.propertyAddress2].filter(Boolean).join(', ') || '—';
}

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

export function formatPence(pence: string | number | bigint | null | undefined): string {
  if (pence == null) return '—';
  const n = typeof pence === 'bigint' ? Number(pence) : Number(pence);
  return GBP.format(n / 100);
}

const SEVERITY: Record<ChaseStage, number> = {
  NOT_DUE: 0,
  AWAITING_WD3: 1,
  WD3_SENT: 2,
  AWAITING_WD5: 3,
  WD5_SENT: 4,
  AWAITING_WD8: 5,
  WD8_SENT: 6,
  AWAITING_WD14: 7,
  WD14_NOTIFIED: 8,
  RESOLVED: -1,
};

export function mostSevereStage(charges: { currentStage: ChaseStage }[]): ChaseStage {
  if (charges.length === 0) return 'NOT_DUE';
  return charges.reduce<ChaseStage>(
    (acc, c) => (SEVERITY[c.currentStage] > SEVERITY[acc] ? c.currentStage : acc),
    'NOT_DUE',
  );
}

export function maxWorkingDaysOverdue(charges: { workingDaysOverdue: number }[]): number {
  return charges.reduce((m, c) => (c.workingDaysOverdue > m ? c.workingDaysOverdue : m), 0);
}
