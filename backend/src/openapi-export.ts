/**
 * Emit the backend's OpenAPI spec to backend/openapi.json so the frontend
 * can regenerate its types. Run via `pnpm --filter backend openapi:export`.
 *
 * This bootstraps the full Nest app to ensure every controller is
 * registered, then writes the spec and exits. It does not start the HTTP
 * listener.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { buildOpenApiConfig } from './openapi-config';

async function main(): Promise<void> {
  // BigInt -> string for any embedded examples that might surface during init.
  (BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
    return this.toString();
  };

  const app = await NestFactory.create(AppModule, { logger: false });
  const doc = SwaggerModule.createDocument(app, buildOpenApiConfig());

  const out = path.resolve(__dirname, '..', 'openapi.json');
  await fs.writeFile(out, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
  await app.close();
  // eslint-disable-next-line no-console
  console.log(`openapi: wrote ${out}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
