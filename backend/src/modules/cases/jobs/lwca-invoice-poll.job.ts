import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, SyncJobKind, SyncJobStatus, type SyncJobRun } from '@prisma/client';
import { PrismaService } from '../../../integrations/prisma/prisma.service';
import {
  LWCA_INVOICE_CLIENT,
  type LwcaInvoiceClient,
} from '../../../integrations/lwca/lwca-invoice.client';
import type { LwcaTenancyHint } from '../../../integrations/lwca/lwca-invoice.mapper';
import { ChargesService } from '../../charges/charges.service';
import { CasesService } from '../cases.service';

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
      for (const inv of invoices) {
        await this.upsertTenancyStub(organisationId, inv.tenancy);
        const open = await this.cases.openOrAttach(organisationId, inv.tenancy.tenancyId);
        if (open.opened) casesOpened++;
        const upsert = await this.charges.upsertFromLwca(open.caseId, inv.charge);
        if (upsert.created) created++;
        else updated++;
        touchedCases.add(open.caseId);
      }
      for (const caseId of touchedCases) {
        const r = await this.cases.recomputeAndMaybeClose(caseId);
        if (r.closed) casesClosed++;
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
