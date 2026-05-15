import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SyncJobKind, SyncJobStatus, type SyncJobRun } from '@prisma/client';
import { PrismaService } from '../../../integrations/prisma/prisma.service';
import { TenancyRefreshService } from '../tenancy-refresh.service';

@Injectable()
export class RentancyTenancyRefreshJob {
  private readonly logger = new Logger(RentancyTenancyRefreshJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyRefresh: TenancyRefreshService,
  ) {}

  /**
   * Hourly: for every distinct (organisationId, tenancyId) attached to an
   * ACTIVE case, re-fetch tenancy + contacts. Per-tenancy errors are logged
   * but don't block the rest of the batch.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    await this.runForAllActive();
  }

  async runForAllActive(): Promise<{
    refreshed: number;
    notFound: number;
    failed: number;
    organisations: number;
  }> {
    const cases = await this.prisma.case.findMany({
      where: { status: 'ACTIVE' },
      select: { organisationId: true, tenancyId: true },
    });
    const seen = new Set<string>();
    const targets: Array<{ organisationId: string; tenancyId: string }> = [];
    for (const c of cases) {
      const key = `${c.organisationId}::${c.tenancyId}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(c);
      }
    }

    const orgIds = new Set(targets.map((t) => t.organisationId));
    const auditByOrg = new Map<string, SyncJobRun>();
    for (const orgId of orgIds) {
      const run = await this.prisma.syncJobRun.create({
        data: {
          organisationId: orgId,
          kind: SyncJobKind.RENTANCY_TENANCY_REFRESH,
          status: SyncJobStatus.RUNNING,
        },
      });
      auditByOrg.set(orgId, run);
    }

    const byOrgCounts = new Map<
      string,
      { refreshed: number; notFound: number; failed: number }
    >();
    for (const orgId of orgIds) {
      byOrgCounts.set(orgId, { refreshed: 0, notFound: 0, failed: 0 });
    }

    for (const t of targets) {
      const counts = byOrgCounts.get(t.organisationId)!;
      try {
        const r = await this.tenancyRefresh.refreshFromRentancy(t.organisationId, t.tenancyId);
        if (r.notFound) counts.notFound++;
        else counts.refreshed++;
      } catch (err) {
        counts.failed++;
        this.logger.warn(
          `rentancy refresh: org=${t.organisationId} tenancy=${t.tenancyId} failed — ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    for (const [orgId, counts] of byOrgCounts) {
      const run = auditByOrg.get(orgId)!;
      await this.prisma.syncJobRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          status: counts.failed > 0 ? SyncJobStatus.FAILED : SyncJobStatus.COMPLETED,
          itemsProcessed: counts.refreshed + counts.notFound + counts.failed,
          itemsUpdated: counts.refreshed,
        },
      });
    }

    return {
      refreshed: sum(byOrgCounts, (v) => v.refreshed),
      notFound: sum(byOrgCounts, (v) => v.notFound),
      failed: sum(byOrgCounts, (v) => v.failed),
      organisations: orgIds.size,
    };
  }
}

function sum<T, V>(map: Map<T, V>, pick: (v: V) => number): number {
  let total = 0;
  for (const v of map.values()) total += pick(v);
  return total;
}
