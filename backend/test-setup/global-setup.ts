import { execSync } from 'node:child_process';
import { Client } from 'pg';

/**
 * Vitest globalSetup: makes sure the test suite always runs against a
 * dedicated `arrears_poc_test` database, never the dev DB. Previously the
 * suite shared `arrears_poc` with `pnpm dev` and `prisma migrate reset`
 * had nuked the user's configured organisations more than once.
 *
 * Steps:
 *  1. Decide on the test DATABASE_URL — `DATABASE_URL_TEST` wins; otherwise
 *     swap the database name on `DATABASE_URL` to `arrears_poc_test`.
 *  2. Connect to the postgres admin DB and `CREATE DATABASE …` if missing.
 *  3. Run `prisma migrate deploy` against the test DB.
 *  4. Set `process.env.DATABASE_URL` for the whole test run so every spec
 *     file (most of which fall back to the dev URL string literal) is
 *     redirected here.
 */
export default async function setup(): Promise<void> {
  const devUrl = process.env.DATABASE_URL ?? 'postgres://arrears:arrears@localhost:5432/arrears_poc';
  const testUrl = process.env.DATABASE_URL_TEST ?? swapDbName(devUrl, 'arrears_poc_test');

  await ensureDatabaseExists(testUrl);

  // migrate deploy is non-destructive: only applies pending migrations,
  // never resets data. Good for a long-lived test DB.
  execSync('pnpm exec prisma migrate deploy --schema ./src/prisma/schema.prisma', {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'inherit',
  });

  process.env.DATABASE_URL = testUrl;
}

function swapDbName(url: string, newName: string): string {
  // postgres://user:pass@host:port/dbname?query
  const parsed = new URL(url);
  parsed.pathname = `/${newName}`;
  return parsed.toString();
}

async function ensureDatabaseExists(targetUrl: string): Promise<void> {
  const parsed = new URL(targetUrl);
  const targetDb = parsed.pathname.replace(/^\//, '');
  if (!targetDb) throw new Error(`Test URL has no database name: ${targetUrl}`);

  const adminUrl = new URL(targetUrl);
  adminUrl.pathname = '/postgres';

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const exists = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = $1',
      [targetDb],
    );
    if (exists.rowCount === 0) {
      // CREATE DATABASE doesn't accept parameterised identifiers; the name
      // comes from a URL parse so we strip anything dangerous.
      const safe = targetDb.replace(/[^a-zA-Z0-9_]/g, '');
      if (safe !== targetDb) {
        throw new Error(`Refusing to create database with unsafe name: ${targetDb}`);
      }
      await client.query(`CREATE DATABASE ${safe}`);
    }
  } finally {
    await client.end();
  }
}
