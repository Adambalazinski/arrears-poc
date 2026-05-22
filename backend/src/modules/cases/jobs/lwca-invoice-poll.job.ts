import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  CaseEventKind,
  CaseStatus,
  ChargeStatus,
  ChaseStage,
  Prisma,
  SyncJobKind,
  SyncJobStatus,
  type SyncJobRun,
} from '@prisma/client';
import { PrismaService } from '../../../integrations/prisma/prisma.service';
import {
  LWCA_INVOICE_CLIENT,
  type LwcaInvoiceClient,
} from '../../../integrations/lwca/lwca-invoice.client';
import { mapWithConcurrency } from '../../../integrations/lwca/http-lwca-invoice.client';
import {
  toBigIntPence,
  type LwcaTenancyHint,
} from '../../../integrations/lwca/lwca-invoice.mapper';
import type { LwcaInvoice } from '../../../integrations/lwca/lwca-invoice.types';
import { ChargesService } from '../../charges/charges.service';
import { TenancyRefreshService } from '../../tenancies/tenancy-refresh.service';
import { CasesService } from '../cases.service';
import { S8EvaluationService } from '../s8-evaluation.service';

const IN_ARREARS_STATUSES: ChargeStatus[] = [
  ChargeStatus.UNPAID,
  ChargeStatus.PARTIALLY_PAID,
  ChargeStatus.PARTIALLY_RECONCILED,
];

const FINAL_PAID_STATUSES: ReadonlySet<ChargeStatus> = new Set([
  ChargeStatus.PAID,
  ChargeStatus.RECONCILED,
]);

/**
 * Statuses that mean "this charge is done — no more chases". When the
 * stale-refresh transitions a charge into one of these, we also flip
 * `currentStage` to RESOLVED so the UI and stage-severity comparisons
 * stop treating it as a live arrears row.
 */
const RESOLVED_TERMINAL_STATUSES: ReadonlySet<ChargeStatus> = new Set([
  ChargeStatus.PAID,
  ChargeStatus.RECONCILED,
  ChargeStatus.DELETED,
]);

export interface PollRunResult {
  organisationId: string;
  syncJobRunId: string;
  processed: number;
  created: number;
  updated: number;
  casesOpened: number;
  casesClosed: number;
  status: SyncJobStatus;
}

/**
 * LWCA invoice poll per docs/business-rules.md R1 + R2.
 *
 * For each organisation with stored credentials:
 *  1. SyncJobRun(kind=LWCA_INVOICE_POLL, status=RUNNING)
 *  2. lwcaClient.listArrears(orgId)
 *  3. for each mapped invoice:
 *       a. upsert a Tenancy stub from the LWCA property block (Phase 4.4
 *          enriches it from Rentancy on case open)
 *       b. CasesService.openOrAttach(orgId, tenancyId) — R1
 *       c. ChargesService.upsertFromLwca(caseId, charge)
 *  4. for each case touched, CasesService.recomputeAndMaybeClose — R2
 *  5. SyncJobRun.finishedAt / status / counts
 *
 * Re-running the job is idempotent: tenancies upsert by id, charges upsert
 * by lwcaInvoiceId, case open is a no-op when one already exists.
 */
@Injectable()
export class LwcaInvoicePollJob {
  private readonly logger = new Logger(LwcaInvoicePollJob.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LWCA_INVOICE_CLIENT) private readonly lwca: LwcaInvoiceClient,
    private readonly cases: CasesService,
    private readonly charges: ChargesService,
    private readonly tenancyRefresh: TenancyRefreshService,
    private readonly s8: S8EvaluationService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async tick(): Promise<void> {
    const orgs = await this.prisma.organisation.findMany({
      where: { credential: { isNot: null } },
      select: { id: true },
    });
    if (orgs.length === 0) {
      this.logger.debug('lwca-invoice-poll: no organisations with credentials, skipping tick');
      return;
    }
    for (const org of orgs) {
      try {
        await this.runForOrg(org.id);
      } catch (err) {
        this.logger.error(
          `lwca-invoice-poll: org ${org.id} failed — ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /**
   * Public for manual / dev-tool triggering and for tests. Records a
   * SyncJobRun audit row whether the run succeeds or fails.
   */
  async runForOrg(organisationId: string): Promise<PollRunResult> {
    const run = await this.startRun(organisationId);
    let processed = 0;
    let created = 0;
    let updated = 0;
    let casesOpened = 0;
    let casesClosed = 0;
    try {
      const invoices = await this.lwca.listArrears(organisationId);
      processed = invoices.length;
      const touchedCases = new Set<string>();
      const tenanciesNeedingRefresh = new Set<string>();
      for (const inv of invoices) {
        await this.upsertTenancyStub(organisationId, inv.tenancy);
        const open = await this.cases.openOrAttach(organisationId, inv.tenancy.tenancyId);
        if (open.opened) {
          casesOpened++;
          tenanciesNeedingRefresh.add(inv.tenancy.tenancyId);
        }
        const upsert = await this.charges.upsertFromLwca(open.caseId, inv.charge);
        if (upsert.created) created++;
        else updated++;
        touchedCases.add(open.caseId);
      }
      // Defect 2: refresh charges that fell off the arrears list. The
      // list query filters by `statuses=UNPAID,PARTIALLY_PAID,
      // PARTIALLY_RECONCILED`, so a charge that just got paid in LWCA
      // never comes back through `listArrears` and our local state
      // would stay UNPAID. Walk every DB charge in arrears status on an
      // ACTIVE case for this org that wasn't seen in this run and
      // refresh it directly via GET /v1/api/invoice/{id}.
      const seenInvoiceIds = new Set(invoices.map((i) => i.charge.lwcaInvoiceId));
      await this.refreshStaleCharges(organisationId, seenInvoiceIds, touchedCases);

      // Phase 4.4: a newly opened case triggers a one-shot Rentancy refresh
      // to populate tenant + guarantor data. Failures are logged but
      // don't fail the polling run — the hourly refresh job will retry.
      for (const tenancyId of tenanciesNeedingRefresh) {
        try {
          await this.tenancyRefresh.refreshFromRentancy(organisationId, tenancyId);
        } catch (err) {
          this.logger.warn(
            `lwca-invoice-poll: rentancy refresh for ${tenancyId} failed — ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      }
      for (const caseId of touchedCases) {
        const r = await this.cases.recomputeAndMaybeClose(caseId);
        if (r.closed) casesClosed++;
        // R6: re-evaluate S8 eligibility against the freshly-synced balance.
        // Charges were just upserted from LWCA, so R5.1 (live balance) is
        // already satisfied. Errors are logged but never fail the poll run.
        if (!r.closed) {
          try {
            await this.s8.evaluate(caseId);
          } catch (err) {
            this.logger.warn(
              `lwca-invoice-poll: s8 evaluation for case ${caseId} failed — ${
                err instanceof Error ? err.message : err
              }`,
            );
          }
        }
      }
      await this.finishRun(run.id, SyncJobStatus.COMPLETED, {
        processed,
        created,
        updated,
        errorJson: null,
      });
      this.logger.log(
        `lwca-invoice-poll org=${organisationId} processed=${processed} created=${created} updated=${updated} opened=${casesOpened} closed=${casesClosed}`,
      );
      return {
        organisationId,
        syncJobRunId: run.id,
        processed,
        created,
        updated,
        casesOpened,
        casesClosed,
        status: SyncJobStatus.COMPLETED,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.finishRun(run.id, SyncJobStatus.FAILED, {
        processed,
        created,
        updated,
        errorJson: { message },
      });
      throw err;
    }
  }

  /**
   * Defect 2: hydrate paid/deleted charges that fell off the arrears list.
   *
   * For each Charge row on an ACTIVE case in this org whose
   * `lastKnownStatus` is still in arrears but whose `lwcaInvoiceId`
   * wasn't returned by `listArrears` this run, fetch the invoice
   * directly via `GET /v1/api/invoice/{id}` and reconcile our local
   * row:
   *   - upstream now PAID / RECONCILED: update status + remain, emit
   *     CHARGE_FULLY_PAID, mark the case as touched so
   *     recomputeAndMaybeClose runs after this loop.
   *   - upstream now DELETED: mirror it locally so case-close treats
   *     it as a final state.
   *   - upstream returned 404 (`null` from the client): same — mark
   *     DELETED locally so the row doesn't keep the case open.
   *   - upstream surprisingly still UNPAID-ish: update status + remain
   *     anyway (defensive — possibly a transient LWCA filtering bug).
   *
   * Per-invoice fetch is capped at 5 in flight (same pool that hydrates
   * the regular arrears list).
   */
  private async refreshStaleCharges(
    organisationId: string,
    seenInvoiceIds: ReadonlySet<string>,
    touchedCases: Set<string>,
  ): Promise<void> {
    const stale = await this.prisma.charge.findMany({
      where: {
        organisationId,
        lastKnownStatus: { in: IN_ARREARS_STATUSES },
        case: { status: CaseStatus.ACTIVE },
        ...(seenInvoiceIds.size > 0
          ? { NOT: { lwcaInvoiceId: { in: Array.from(seenInvoiceIds) } } }
          : {}),
      },
      select: {
        id: true,
        lwcaInvoiceId: true,
        caseId: true,
        lastKnownStatus: true,
        grossAmountPence: true,
        lastKnownRemainAmountPence: true,
      },
    });
    if (stale.length === 0) return;

    await mapWithConcurrency(stale, 5, async (c) => {
      try {
        const fresh = await this.lwca.getInvoice(organisationId, c.lwcaInvoiceId);
        await this.applyStaleRefresh(c, fresh);
        touchedCases.add(c.caseId);
      } catch (err) {
        this.logger.warn(
          `lwca-invoice-poll: stale-refresh failed for charge ${c.id} (invoice ${c.lwcaInvoiceId}) — ${err instanceof Error ? err.message : err}`,
        );
      }
    });
    this.logger.log(
      `lwca-invoice-poll: refreshed ${stale.length} stale charge(s) for org=${organisationId}`,
    );
  }

  private async applyStaleRefresh(
    local: {
      id: string;
      caseId: string;
      lwcaInvoiceId: string;
      lastKnownStatus: ChargeStatus;
      grossAmountPence: bigint;
      lastKnownRemainAmountPence: bigint;
    },
    fresh: LwcaInvoice | null,
  ): Promise<void> {
    const now = new Date();
    if (fresh === null) {
      // 404: upstream no longer has this invoice. Mirror as DELETED and
      // zero the remain — a deleted invoice has no outstanding amount,
      // so recomputeAndMaybeClose can close the case naturally. Stage
      // moves to RESOLVED so the charge stops looking like a live row
      // in stage-severity comparisons.
      await this.prisma.charge.update({
        where: { id: local.id },
        data: {
          lastKnownStatus: ChargeStatus.DELETED,
          lastKnownRemainAmountPence: 0n,
          lastSyncedAt: now,
          currentStage: ChaseStage.RESOLVED,
          currentStageEnteredAt: now,
        },
      });
      return;
    }
    const newStatus = fresh.status as ChargeStatus;
    const newRemain = toBigIntPence(fresh.remainAmount);
    const movingToResolved = RESOLVED_TERMINAL_STATUSES.has(newStatus);
    await this.prisma.charge.update({
      where: { id: local.id },
      data: {
        lastKnownStatus: newStatus,
        lastKnownRemainAmountPence: newRemain,
        lastSyncedAt: now,
        ...(movingToResolved
          ? { currentStage: ChaseStage.RESOLVED, currentStageEnteredAt: now }
          : {}),
      },
    });
    if (FINAL_PAID_STATUSES.has(newStatus)) {
      await this.prisma.caseEvent.create({
        data: {
          caseId: local.caseId,
          kind: CaseEventKind.CHARGE_FULLY_PAID,
          payloadJson: {
            chargeId: local.id,
            lwcaInvoiceId: local.lwcaInvoiceId,
            previousStatus: local.lastKnownStatus,
            newStatus,
          },
        },
      });
    }
  }

  private async upsertTenancyStub(
    organisationId: string,
    hint: LwcaTenancyHint,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.tenancy.upsert({
      where: { id: hint.tenancyId },
      create: {
        id: hint.tenancyId,
        organisationId,
        propertyId: hint.propertyId,
        propertyName: hint.propertyName,
        propertyAddress1: hint.propertyAddress1,
        propertyAddress2: hint.propertyAddress2,
        status: 'UNKNOWN',
        lastSyncedAt: now,
      },
      update: {
        // Only the LWCA-derived display fields. Status / reference / contact
        // links land here from Rentancy in Phase 4.4 — preserved by leaving
        // them out of the update payload.
        propertyId: hint.propertyId,
        propertyName: hint.propertyName,
        propertyAddress1: hint.propertyAddress1,
        propertyAddress2: hint.propertyAddress2,
      },
    });
  }

  private startRun(organisationId: string): Promise<SyncJobRun> {
    return this.prisma.syncJobRun.create({
      data: {
        organisationId,
        kind: SyncJobKind.LWCA_INVOICE_POLL,
        status: SyncJobStatus.RUNNING,
      },
    });
  }

  private finishRun(
    id: string,
    status: SyncJobStatus,
    counts: {
      processed: number;
      created: number;
      updated: number;
      errorJson: Record<string, unknown> | null;
    },
  ): Promise<SyncJobRun> {
    return this.prisma.syncJobRun.update({
      where: { id },
      data: {
        finishedAt: new Date(),
        status,
        itemsProcessed: counts.processed,
        itemsCreated: counts.created,
        itemsUpdated: counts.updated,
        errorJson:
          counts.errorJson === null
            ? undefined
            : (counts.errorJson as Prisma.InputJsonValue),
      },
    });
  }
}
