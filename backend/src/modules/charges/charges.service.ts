import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CaseEventKind,
  type Charge,
  type ChaseStage,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import type { LwcaChargeUpsert } from '../../integrations/lwca/lwca-invoice.mapper';

export interface ChargeUpsertResult {
  charge: Charge;
  created: boolean;
}

@Injectable()
export class ChargesService {
  private readonly logger = new Logger(ChargesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent upsert keyed by lwcaInvoiceId. First sync inserts; later
   * syncs update only the fields LWCA can legitimately change
   * (status, remain, payment cycle). grossAmountPence / dueDate /
   * invoiceDate are write-once per docs/canonical-data-model.md
   * ("grossAmount: immutable after first sync").
   *
   * Emits CHARGE_ADDED on create. The polling job decides whether to
   * also emit CHARGE_SYNCED on update — keeping that decision outside the
   * upsert so the timeline only records meaningful changes.
   */
  async upsertFromLwca(caseId: string, input: LwcaChargeUpsert): Promise<ChargeUpsertResult> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.charge.findUnique({
        where: { lwcaInvoiceId: input.lwcaInvoiceId },
        select: { id: true, caseId: true },
      });

      if (existing) {
        const charge = await tx.charge.update({
          where: { lwcaInvoiceId: input.lwcaInvoiceId },
          data: {
            lastKnownRemainAmountPence: input.lastKnownRemainAmountPence,
            lastKnownStatus: input.lastKnownStatus,
            lastKnownPaymentCycleType: input.lastKnownPaymentCycleType,
            lastSyncedAt: input.lastSyncedAt,
          },
        });
        return { charge, created: false };
      }

      const charge = await tx.charge.create({
        data: {
          caseId,
          organisationId: input.organisationId,
          lwcaInvoiceId: input.lwcaInvoiceId,
          dueDate: input.dueDate,
          invoiceDate: input.invoiceDate,
          grossAmountPence: input.grossAmountPence,
          lastKnownRemainAmountPence: input.lastKnownRemainAmountPence,
          lastKnownStatus: input.lastKnownStatus,
          lastKnownPaymentCycleType: input.lastKnownPaymentCycleType,
          lastSyncedAt: input.lastSyncedAt,
        },
      });

      await tx.caseEvent.create({
        data: {
          caseId,
          kind: CaseEventKind.CHARGE_ADDED,
          payloadJson: {
            chargeId: charge.id,
            lwcaInvoiceId: charge.lwcaInvoiceId,
            grossAmountPence: charge.grossAmountPence.toString(),
            lastKnownStatus: charge.lastKnownStatus,
            dueDate: charge.dueDate.toISOString(),
          },
        },
      });
      return { charge, created: true };
    });
  }

  /**
   * Atomic stage advancement. Used by the chase tick job (R3.4): when a WD
   * threshold is crossed, the cadence engine moves Charge.currentStage and
   * records the entry time. Returns the updated row.
   */
  async advanceStage(chargeId: string, toStage: ChaseStage): Promise<Charge> {
    try {
      return await this.prisma.charge.update({
        where: { id: chargeId },
        data: {
          currentStage: toStage,
          currentStageEnteredAt: new Date(),
        },
      });
    } catch (err) {
      if (isRecordNotFound(err)) {
        throw new NotFoundException(`Charge ${chargeId} not found`);
      }
      throw err;
    }
  }

  findById(chargeId: string): Promise<Charge | null> {
    return this.prisma.charge.findUnique({ where: { id: chargeId } });
  }

  listByCase(caseId: string): Promise<Charge[]> {
    return this.prisma.charge.findMany({
      where: { caseId },
      orderBy: { dueDate: 'asc' },
    });
  }
}

function isRecordNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string };
  return e.code === 'P2025';
}

export type { LwcaChargeUpsert };
export type { ChaseStage as ChaseStageEnum, Charge as ChargeRow };
export type { Prisma };
