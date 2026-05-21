import { Inject, Injectable, Logger } from '@nestjs/common';
import { CaseEventKind, CaseStatus, CommunicationStatus } from '@prisma/client';
import {
  LWCA_INVOICE_CLIENT,
  type LwcaInvoiceClient,
} from '../../integrations/lwca/lwca-invoice.client';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import { CasesService } from '../cases/cases.service';

export interface PurgeNonRentResult {
  organisationId: string;
  scanned: number;
  deleted: string[]; // charge IDs
  casesClosed: string[]; // case IDs we had to close because every charge was non-rent
  casesRecomputed: string[]; // case IDs whose balance/state we refreshed
}

/**
 * One-shot cleanup for Charge rows whose underlying LWCA invoice doesn't
 * contain a Rent line item. Arrears chasing is rent-only — anything else
 * shouldn't have been synced in the first place. We fetch the raw arrears
 * list (no mapper filter), match by invoice id, and delete Charge rows
 * whose invoice has no Rent line item.
 *
 * Invoices that no longer appear upstream at all (e.g. paid + archived)
 * are *not* touched here — the regular case-close flow handles those.
 */
@Injectable()
export class PurgeNonRentService {
  private readonly logger = new Logger(PurgeNonRentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cases: CasesService,
    @Inject(LWCA_INVOICE_CLIENT) private readonly lwca: LwcaInvoiceClient,
  ) {}

  async runForOrg(organisationId: string): Promise<PurgeNonRentResult> {
    const raw = await this.lwca.listAllRaw(organisationId);
    const rentByInvoiceId = new Map<string, boolean>();
    for (const inv of raw) {
      const hasRent = (inv.lineItems ?? []).some((li) => li.type === 'Rent');
      rentByInvoiceId.set(inv.id, hasRent);
    }

    const charges = await this.prisma.charge.findMany({
      where: { organisationId },
      select: { id: true, lwcaInvoiceId: true, caseId: true },
    });

    const toDelete = charges.filter((c) => rentByInvoiceId.get(c.lwcaInvoiceId) === false);
    const affectedCaseIds = new Set(toDelete.map((c) => c.caseId).filter((id): id is string => !!id));

    const deleted: string[] = [];
    if (toDelete.length > 0) {
      await this.prisma.charge.deleteMany({
        where: { id: { in: toDelete.map((c) => c.id) } },
      });
      deleted.push(...toDelete.map((c) => c.id));
    }

    const casesClosed: string[] = [];
    const casesRecomputed: string[] = [];
    for (const caseId of affectedCaseIds) {
      const remaining = await this.prisma.charge.count({ where: { caseId } });
      if (remaining === 0) {
        // canClose() refuses to close a case with no charges, so we close
        // it here directly with a dedicated reason.
        await this.closeEmptyCase(caseId);
        casesClosed.push(caseId);
      } else {
        await this.cases.recomputeAndMaybeClose(caseId);
        casesRecomputed.push(caseId);
      }
    }

    this.logger.log(
      `purge-non-rent org=${organisationId} scanned=${charges.length} deleted=${deleted.length} closed=${casesClosed.length} recomputed=${casesRecomputed.length}`,
    );

    return {
      organisationId,
      scanned: charges.length,
      deleted,
      casesClosed,
      casesRecomputed,
    };
  }

  private async closeEmptyCase(caseId: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.case.update({
        where: { id: caseId },
        data: {
          status: CaseStatus.CLOSED,
          closedAt: now,
          lastKnownBalancePence: 0n,
          lastKnownBalanceAt: now,
        },
      });
      await tx.caseEvent.create({
        data: {
          caseId,
          kind: CaseEventKind.CASE_CLOSED,
          payloadJson: { reason: 'purge_non_rent', chargeCount: 0 },
        },
      });
      await tx.chaseScheduleEntry.updateMany({
        where: { caseId, firedAt: null, skippedReason: null },
        data: { skippedReason: 'CASE_CLOSED', firedAt: now },
      });
      await tx.communication.updateMany({
        where: {
          caseId,
          direction: 'OUTBOUND',
          status: CommunicationStatus.AWAITING_APPROVAL,
        },
        data: {
          status: CommunicationStatus.AUTO_REJECTED,
          rejectedAt: now,
          rejectionReason: 'case closed (purge non-rent)',
        },
      });
      await tx.reviewQueueItem.updateMany({
        where: { caseId, resolvedAt: null },
        data: { resolvedAt: now, resolution: 'DISMISSED' },
      });
    });
  }
}
