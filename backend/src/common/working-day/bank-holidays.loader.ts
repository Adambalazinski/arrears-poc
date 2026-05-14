import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type { GovUkBankHolidays } from './types';

const GOV_UK_URL = 'https://www.gov.uk/bank-holidays.json';
const CACHE_FILENAME = 'bank-holidays.json';

@Injectable()
export class BankHolidaysLoader {
  private readonly logger = new Logger(BankHolidaysLoader.name);
  private readonly cachePath = path.join(process.cwd(), '.cache', CACHE_FILENAME);

  /**
   * Fetch fresh data from gov.uk. Persists the response to a local file cache
   * for offline restarts. Network errors fall through to the file cache;
   * if neither succeeds the caller decides whether that's fatal.
   */
  async load(): Promise<GovUkBankHolidays> {
    try {
      const fresh = await this.fetchFromNetwork();
      await this.saveCache(fresh);
      return fresh;
    } catch (err) {
      this.logger.warn(
        `gov.uk fetch failed (${err instanceof Error ? err.message : err}); falling back to file cache`,
      );
      const cached = await this.tryReadCache();
      if (cached) return cached;
      throw new Error(
        `Bank-holiday calendar unavailable: gov.uk fetch failed and no cache at ${this.cachePath}`,
      );
    }
  }

  /** Test/dev helper: read the cache file only, no network call. */
  async tryReadCache(): Promise<GovUkBankHolidays | null> {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf-8');
      return JSON.parse(raw) as GovUkBankHolidays;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.logger.warn(`bank-holiday cache read failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async fetchFromNetwork(): Promise<GovUkBankHolidays> {
    const res = await fetch(GOV_UK_URL);
    if (!res.ok) throw new Error(`gov.uk returned HTTP ${res.status}`);
    return (await res.json()) as GovUkBankHolidays;
  }

  private async saveCache(data: GovUkBankHolidays): Promise<void> {
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.writeFile(this.cachePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
