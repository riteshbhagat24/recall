import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  AudioRef,
  TranscribeOptions,
  TranscriptionDriver,
  TranscriptResult,
} from './types.js';

/**
 * MockDriver — lets the entire pipeline (capture → transcribe → structure → KB →
 * search) run end-to-end with NO external speech vendor or API key. Essential
 * for local dev, CI, and the benchmark harness scaffolding.
 *
 * Behavior:
 *  - If a sidecar file `<audio>.transcript.json` exists, it is returned verbatim
 *    (used to replay known fixtures / golden transcripts for the benchmark).
 *  - Otherwise it synthesizes a small deterministic 2-speaker Hinglish transcript
 *    so downstream stages have realistic, code-mixed text to work on.
 */
export class MockDriver implements TranscriptionDriver {
  readonly name = 'mock';

  async transcribe(audio: AudioRef, _opts: TranscribeOptions): Promise<TranscriptResult> {
    const sidecar = `${audio.storagePath}.transcript.json`;
    try {
      const raw = await readFile(sidecar, 'utf8');
      const parsed = JSON.parse(raw) as TranscriptResult;
      return { ...parsed, engineUsed: 'mock' };
    } catch {
      // no fixture — synthesize
    }

    const label = basename(audio.storagePath);
    const turns = [
      {
        speakerLabel: 'Speaker 1',
        startTs: 0,
        endTs: 7.5,
        text: `Haan toh basically humne ${label} campaign ka ROAS dekha aur it's not scaling the way we expected.`,
        detectedLang: 'hi-en',
      },
      {
        speakerLabel: 'Speaker 2',
        startTs: 7.5,
        endTs: 15.2,
        text: 'Theek hai, let us reduce the budget on the underperforming ad sets and reallocate to the top three creatives by Friday.',
        detectedLang: 'hi-en',
      },
      {
        speakerLabel: 'Speaker 1',
        startTs: 15.2,
        endTs: 22.0,
        text: 'Decision: we move 40 percent budget to the new creative. Also the GST invoice for last month is still pending from finance.',
        detectedLang: 'hi-en',
      },
    ];

    return {
      fullText: turns.map((t) => `${t.speakerLabel}: ${t.text}`).join('\n'),
      turns,
      engineUsed: 'mock',
      languageSummary: 'Hinglish (hi+en code-mixed) — synthesized by MockDriver',
    };
  }
}
