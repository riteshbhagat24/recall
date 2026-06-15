import { PrismaClient } from '@prisma/client';
import { config } from '../src/config.js';
import { ENGINE_CONFIG_KEY } from '../src/adapters/transcription/index.js';

const prisma = new PrismaClient();

/**
 * Seeds engine_config defaults + a demo client/project + one user per role so
 * the dev-auth header shim (x-user-id) can exercise every permission path,
 * including the Design & Video financial-lock and the performance-team scope.
 */
async function main() {
  await prisma.engineConfig.upsert({
    where: { key: ENGINE_CONFIG_KEY },
    create: { key: ENGINE_CONFIG_KEY, value: config.TRANSCRIPTION_ENGINE },
    update: {},
  });

  const acme = await prisma.client.upsert({
    where: { id: 1 },
    create: { id: 1, name: 'Acme Corp' },
    update: {},
  });
  const globex = await prisma.client.upsert({
    where: { id: 2 },
    create: { id: 2, name: 'Globex' },
    update: {},
  });
  const project = await prisma.project.upsert({
    where: { id: 1 },
    create: { id: 1, clientId: acme.id, name: 'Q3 Growth Campaign' },
    update: {},
  });
  await prisma.project.upsert({
    where: { id: 2 },
    create: { id: 2, clientId: globex.id, name: 'Brand Refresh' },
    update: {},
  });

  const users = [
    { id: 1, name: 'Maya (Super Admin)', email: 'maya@futuready.test', role: 'super_admin' as const },
    { id: 2, name: 'Arjun (CS Lead)', email: 'arjun@futuready.test', role: 'admin_cs_lead' as const },
    { id: 3, name: 'Bina (BD)', email: 'bina@futuready.test', role: 'bd' as const },
    { id: 4, name: 'Farah (Finance)', email: 'farah@futuready.test', role: 'finance' as const },
    { id: 5, name: 'Cyrus (CS)', email: 'cyrus@futuready.test', role: 'cs' as const },
    { id: 6, name: 'Priya (Performance)', email: 'priya@futuready.test', role: 'performance' as const },
    { id: 7, name: 'Dev (Design & Video)', email: 'dev@futuready.test', role: 'design_video' as const },
  ];
  for (const u of users) {
    await prisma.user.upsert({ where: { id: u.id }, create: u, update: { role: u.role } });
  }

  // Performance user is scoped to Acme only (so Globex must be invisible to her).
  await prisma.clientAssignment.upsert({
    where: { userId_clientId: { userId: 6, clientId: acme.id } },
    create: { userId: 6, clientId: acme.id },
    update: {},
  });

  // eslint-disable-next-line no-console
  console.log('Seeded: engine_config, 2 clients, 2 projects, 7 role users, 1 assignment');
  console.log(`Demo upload target: client_id=${acme.id} project_id=${project.id}`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
