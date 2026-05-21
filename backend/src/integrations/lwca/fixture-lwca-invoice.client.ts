import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type {
  LwcaInvoiceClient,
  LwcaProbeOutcome,
} from './lwca-invoice.client';
import { LwcaInvoiceMapper, type MappedLwcaInvoice } from './lwca-invoice.mapper';
import { LwcaPagedInvoicesSchema, type LwcaInvoice } from './lwca-invoice.types';

/**
 * Offline implementation used by tests and `INTEGRATION_MODE=fixtures`. Reads
 * `fixtures/lwca/invoices-list.json`. The repo path is resolved from the
 * backend cwd: `../fixtures/lwca/`.
 */
@Injectable()
export class FixtureLwcaInvoiceClient implements LwcaInvoiceClient {
  private readonly logger = new Logger(FixtureLwcaInvoiceClient.name);
  private readonly fixturePath: string;

  constructor(fixturePath?: string) {
    this.fixturePath =
      fixturePath ?? path.resolve(process.cwd(), '../fixtures/lwca/invoices-list.json');
  }

  async listArrears(_organisationId: string): Promise<MappedLwcaInvoice[]> {
    return LwcaInvoiceMapper.mapPage(await this.listAllRaw(_organisationId));
  }

  async listAllRaw(_organisationId: string): Promise<LwcaInvoice[]> {
    const raw = await fs.readFile(this.fixturePath, 'utf-8');
    const parsed = LwcaPagedInvoicesSchema.parse(JSON.parse(raw));
    return parsed.content;
  }

  async probe(_organisationId: string, _accessToken: string): Promise<LwcaProbeOutcome> {
    // Fixture mode probes don't actually call anything; reading the fixture
    // file is the only way they can fail, so we do a stat() to surface a
    // useful error if the file is missing.
    try {
      await fs.stat(this.fixturePath);
      return { ok: true, message: `fixture present at ${this.fixturePath}`, latencyMs: 0 };
    } catch (err) {
      return {
        ok: false,
        message: `fixture missing: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: 0,
      };
    }
  }
}
