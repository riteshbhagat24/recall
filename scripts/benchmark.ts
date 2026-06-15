import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  MockDriver,
} from '../src/adapters/transcription/mock.js';
import { SarvamDriver } from '../src/adapters/transcription/sarvam.js';
import { OpenAIDriver } from '../src/adapters/transcription/openai.js';
import { DEFAULT_TRANSCRIBE_OPTIONS, type TranscriptionDriver } from '../src/adapters/transcription/types.js';
import { config } from '../src/config.js';

/**
 * The benchmark gate (PRD §US-3 / §13.5, the single most important checkpoint).
 *
 * Each case in benchmark/cases/*.json provides a real call's audio path and a
 * human reference transcript. We run the chosen engine THROUGH the adapter and
 * score word error rate (WER) against the reference as a proxy for "usable
 * without heavy correction". The MVP gate is >=90% of calls usable.
 *
 * WER is a proxy, not the human rating the PRD ultimately requires — pair this
 * with a manual spot-check. But it makes the gate runnable in CI and on every
 * engine swap.
 *
 * Usage: npm run benchmark -- [engine] [werThreshold]
 *   engine: mock | sarvam | openai   (default: TRANSCRIPTION_ENGINE env)
 *   werThreshold: max WER to count a call "usable" (default 0.30)
 */

interface BenchCase {
  name: string;
  audioPath: string;
  reference: string; // human-corrected transcript text
}

const DRIVERS: Record<string, () => TranscriptionDriver> = {
  mock: () => new MockDriver(),
  sarvam: () => new SarvamDriver(),
  openai: () => new OpenAIDriver(),
};

async function main() {
  const engineName = process.argv[2] ?? config.TRANSCRIPTION_ENGINE;
  const werThreshold = Number(process.argv[3] ?? '0.30');
  const driverFactory = DRIVERS[engineName];
  if (!driverFactory) {
    console.error(`Unknown engine '${engineName}'. Options: ${Object.keys(DRIVERS).join(', ')}`);
    process.exit(2);
  }
  const driver = driverFactory();

  const here = dirname(fileURLToPath(import.meta.url));
  const casesDir = resolve(here, '..', 'benchmark', 'cases');
  let files: string[] = [];
  try {
    files = (await readdir(casesDir)).filter((f) => f.endsWith('.json'));
  } catch {
    console.error(`No benchmark cases found at ${casesDir}. Add real-call fixtures to run the gate.`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error('No .json cases in benchmark/cases. Need ~10 real Hinglish calls (PRD US-3).');
    process.exit(2);
  }

  console.log(`\nBenchmark gate — engine: ${engineName}, WER threshold: ${werThreshold}`);
  console.log('─'.repeat(72));

  let usable = 0;
  const rows: { name: string; wer: number; usable: boolean }[] = [];
  for (const f of files) {
    const c = JSON.parse(await readFile(join(casesDir, f), 'utf8')) as BenchCase;
    const audioPath = resolve(casesDir, c.audioPath);
    const result = await driver.transcribe(
      { storagePath: audioPath },
      { ...DEFAULT_TRANSCRIBE_OPTIONS, timeoutMs: 600_000, chunkSeconds: config.TRANSCRIBE_CHUNK_SECONDS },
    );
    const wer = computeWER(c.reference, result.fullText);
    const isUsable = wer <= werThreshold;
    if (isUsable) usable++;
    rows.push({ name: c.name, wer, usable: isUsable });
    console.log(`${isUsable ? '✓' : '✗'} ${c.name.padEnd(40)} WER ${(wer * 100).toFixed(1)}%`);
  }

  const pct = (usable / rows.length) * 100;
  console.log('─'.repeat(72));
  console.log(`Usable: ${usable}/${rows.length} (${pct.toFixed(1)}%) — gate requires >= 90%`);
  const passed = pct >= 90;
  console.log(passed ? '\nGATE PASSED ✅' : '\nGATE FAILED ❌ — do not ship this engine for transcription');
  process.exit(passed ? 0 : 1);
}

/** Token-level word error rate via Levenshtein on word sequences. */
function computeWER(reference: string, hypothesis: string): number {
  const ref = normalize(reference);
  const hyp = normalize(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const d: number[][] = Array.from({ length: ref.length + 1 }, () =>
    new Array<number>(hyp.length + 1).fill(0),
  );
  for (let i = 0; i <= ref.length; i++) d[i]![0] = i;
  for (let j = 0; j <= hyp.length; j++) d[0]![j] = j;
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  return d[ref.length]![hyp.length]! / ref.length;
}

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/^speaker \d+:/gim, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
