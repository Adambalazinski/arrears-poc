import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Postgres advisory-lock-backed mutex keyed by an arbitrary string.
 * The lock is transaction-scoped — when the wrapping `$transaction` returns
 * (commit or rollback), the lock is released automatically.
 *
 * `hashtext(...)::bigint` collapses the key into the bigint argument that
 * `pg_advisory_xact_lock` accepts. The collision rate is fine for our
 * key space (one entry per organisation).
 */
export interface RefreshLock {
  acquire<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export const REFRESH_LOCK = Symbol('REFRESH_LOCK');

@Injectable()
export class PostgresAdvisoryRefreshLock implements RefreshLock {
  constructor(private readonly prisma: PrismaService) {}

  async acquire<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
          `arrears:refresh:${key}`,
        );
        return fn();
      },
      { timeout: 30_000 },
    );
  }
}
