import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import {
  RentancyNotFoundError,
  type RentancyProbeOutcome,
  type RentancyTenancyClient,
} from './rentancy.client';
import { RentancyMapper, type RentancyContactUpsert, type RentancyTenancyUpsert } from './rentancy.mapper';
import { RentancyContactSchema, RentancyTenancySchema } from './rentancy.types';

@Injectable()
export class FixtureRentancyClient implements RentancyTenancyClient {
  private readonly logger = new Logger(FixtureRentancyClient.name);
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.resolve(process.cwd(), '../fixtures/rentancy');
  }

  async getTenancy(_orgId: string, tenancyId: string): Promise<RentancyTenancyUpsert> {
    const file = path.join(this.baseDir, 'tenancies', `${tenancyId}.json`);
    const raw = await readOrNotFound(file, 'tenancy', tenancyId);
    return RentancyMapper.tenancy(RentancyTenancySchema.parse(JSON.parse(raw)));
  }

  async getContact(_orgId: string, contactId: string): Promise<RentancyContactUpsert> {
    const file = path.join(this.baseDir, 'contacts', `${contactId}.json`);
    const raw = await readOrNotFound(file, 'contact', contactId);
    return RentancyMapper.contact(RentancyContactSchema.parse(JSON.parse(raw)));
  }

  async probe(_organisationId: string, _accessToken: string): Promise<RentancyProbeOutcome> {
    try {
      await fs.stat(path.join(this.baseDir, 'tenancies'));
      return { ok: true, message: `fixtures present at ${this.baseDir}`, latencyMs: 0 };
    } catch (err) {
      return {
        ok: false,
        message: `fixtures missing: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: 0,
      };
    }
  }
}

async function readOrNotFound(
  file: string,
  kind: 'tenancy' | 'contact',
  id: string,
): Promise<string> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RentancyNotFoundError(kind, id);
    }
    throw err;
  }
}
