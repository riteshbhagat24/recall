import { prisma } from '../db.js';

export const HEARTBEAT_KEY = 'WORKER_HEARTBEAT';

/** Worker writes a timestamp each tick; /health flags stale > 5 min (REQ-16.1). */
export async function beat(): Promise<void> {
  const now = new Date().toISOString();
  await prisma.engineConfig.upsert({
    where: { key: HEARTBEAT_KEY },
    create: { key: HEARTBEAT_KEY, value: now },
    update: { value: now },
  });
}

export async function lastBeat(): Promise<Date | null> {
  const row = await prisma.engineConfig.findUnique({ where: { key: HEARTBEAT_KEY } });
  return row ? new Date(row.value) : null;
}
