/**
 * Minimal demo seed.
 *
 * Creates the `demo-org` organisation (the id the fixture LWCA + Rentancy
 * payloads point at) with default config so the UI has somewhere to log
 * in. Credentials are added via the frontend "Add credentials" form —
 * INTEGRATION_MODE=fixtures means any non-empty token works.
 *
 * Idempotent: re-running the seed leaves existing rows alone.
 */
import { PrismaClient } from '@prisma/client';
import { DEFAULT_ORG_CONFIG } from '../modules/organisations/defaults';

const DEMO_ORG_ID = 'demo-org';
const DEMO_ORG_NAME = 'Demo Lettings Ltd';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organisation.upsert({
      where: { id: DEMO_ORG_ID },
      create: { id: DEMO_ORG_ID, name: DEMO_ORG_NAME },
      update: {},
    });
    console.log(`organisation: ${org.id} (${org.name})`);

    const existingConfig = await prisma.organisationConfig.findUnique({
      where: { organisationId: DEMO_ORG_ID },
    });
    if (existingConfig) {
      console.log('organisationConfig: already present, leaving as-is');
    } else {
      await prisma.organisationConfig.create({
        data: {
          ...DEFAULT_ORG_CONFIG,
          organisation: { connect: { id: DEMO_ORG_ID } },
        },
      });
      console.log('organisationConfig: created with defaults');
    }

    console.log('\nNext: open http://localhost:5173, click into the org,');
    console.log('add credentials (any non-empty string works in fixtures');
    console.log('mode), then call POST /api/dev/force-sync/demo-org.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
