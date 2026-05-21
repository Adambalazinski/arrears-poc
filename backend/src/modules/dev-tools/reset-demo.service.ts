import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../integrations/prisma/prisma.service';
import { LwcaInvoicePollJob } from '../cases/jobs/lwca-invoice-poll.job';

export interface ResetDemoCounts {
  reviewQueueItems: number;
  caseEvents: number;
  chaseScheduleEntries: number;
  escalationFlags: number;
  classificationResults: number;
  promises: number;
  communications: number;
  charges: number;
  cases: number;
  syncJobRuns: number;
}

export interface ResetDemoResult {
  organisationId: string;
  deleted: ResetDemoCounts;
  resync: Awaited<ReturnType<LwcaInvoicePollJob['runForOrg']>>;
}

/**
 * Wipes all per-case derived state for one organisation so the demo can
 * be re-walked from a clean slate, then triggers a fresh LWCA sync.
 *
 * Kept (so credentials and upstream caches survive): Organisation,
 * OrganisationConfig, OrganisationCredential, Tenancy, Contact,
 * TenancyContact. Re-syncing rebuilds Case/Charge from the live upstream
 * data; classification/chase artefacts regenerate on the next chase tick
 * and inbound poll.
 *
 * Orphan inbound rows are *not* touched — they're global (no
 * organisationId column) and wiping them would affect other orgs. If
 * you need to clear orphans, do it manually.
 */
@Injectable()
export class ResetDemoService {
  private readonly logger = new Logger(ResetDemoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lwcaPoll: LwcaInvoicePollJob,
  ) {}

  async runForOrg(organisationId: string): Promise<ResetDemoResult> {
    const deleted = await this.prisma.$transaction(async (tx) => {
      // FK order matters — no onDelete cascades in this schema. Walk
      // child tables before parents.
      const reviewQueueItems = await tx.reviewQueueItem.deleteMany({
        where: { organisationId },
      });
      const caseEvents = await tx.caseEvent.deleteMany({
        where: { case: { organisationId } },
      });
      const chaseScheduleEntries = await tx.chaseScheduleEntry.deleteMany({
        where: { case: { organisationId } },
      });
      const escalationFlags = await tx.escalationFlag.deleteMany({
        where: { case: { organisationId } },
      });
      const classificationResults = await tx.classificationResult.deleteMany({
        where: { case: { organisationId } },
      });
      const promises = await tx.promise.deleteMany({
        where: { case: { organisationId } },
      });
      const communications = await tx.communication.deleteMany({
        where: { organisationId },
      });
      const charges = await tx.charge.deleteMany({ where: { organisationId } });
      const cases = await tx.case.deleteMany({ where: { organisationId } });
      const syncJobRuns = await tx.syncJobRun.deleteMany({
        where: { organisationId },
      });

      return {
        reviewQueueItems: reviewQueueItems.count,
        caseEvents: caseEvents.count,
        chaseScheduleEntries: chaseScheduleEntries.count,
        escalationFlags: escalationFlags.count,
        classificationResults: classificationResults.count,
        promises: promises.count,
        communications: communications.count,
        charges: charges.count,
        cases: cases.count,
        syncJobRuns: syncJobRuns.count,
      };
    });

    this.logger.log(
      `reset-demo org=${organisationId} deleted=${JSON.stringify(deleted)}`,
    );

    const resync = await this.lwcaPoll.runForOrg(organisationId);

    return { organisationId, deleted, resync };
  }
}
