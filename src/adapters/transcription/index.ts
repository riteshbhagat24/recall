import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { MockDriver } from './mock.js';
import { OpenAIDriver } from './openai.js';
import { SarvamDriver } from './sarvam.js';
import type { TranscriptionDriver } from './types.js';

export * from './types.js';

const REGISTRY: Record<string, () => TranscriptionDriver> = {
  mock: () => new MockDriver(),
  sarvam: () => new SarvamDriver(),
  openai: () => new OpenAIDriver(),
};

export const ENGINE_CONFIG_KEY = 'TRANSCRIPTION_ENGINE';

/**
 * Resolve the active engine name: admin-set engine_config row wins (PRD F10,
 * REQ-4.10), env default otherwise. This is the ONE place engine selection
 * happens; callers ask for `getTranscriptionDriver()` and never name a vendor.
 */
export async function resolveEngineName(): Promise<string> {
  const row = await prisma.engineConfig.findUnique({ where: { key: ENGINE_CONFIG_KEY } });
  const name = row?.value ?? config.TRANSCRIPTION_ENGINE;
  return REGISTRY[name] ? name : config.TRANSCRIPTION_ENGINE;
}

export async function getTranscriptionDriver(): Promise<TranscriptionDriver> {
  const name = await resolveEngineName();
  const factory = REGISTRY[name] ?? REGISTRY.mock!;
  return factory();
}

export function listEngines(): string[] {
  return Object.keys(REGISTRY);
}
