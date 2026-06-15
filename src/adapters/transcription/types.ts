/**
 * The transcription adapter contract (PRD §11, REQ-5.1 / REQ-11.1).
 *
 * THE ONLY CODE THAT KNOWS ABOUT A SPECIFIC SPEECH VENDOR IS A DRIVER CLASS
 * IMPLEMENTING THIS INTERFACE. Capture, structuring, KB, search and memory all
 * consume the normalized `TranscriptResult` and never reference Sarvam/OpenAI/
 * Whisper. Swapping engines = swap the driver + flip a config key.
 */

export interface TranscriptTurnResult {
  speakerLabel: string; // diarized label, e.g. "Speaker 1" (named mapping = Phase 2)
  startTs: number; // seconds from start of audio
  endTs: number;
  text: string;
  detectedLang?: string; // ISO-ish hint when the engine provides it (hi/mr/en/...)
}

export interface TranscriptResult {
  fullText: string;
  turns: TranscriptTurnResult[];
  engineUsed: string; // concrete engine id for telemetry/cost (e.g. "sarvam")
  languageSummary: string; // human-readable, e.g. "Hinglish (hi+en code-mixed)"
}

export interface TranscribeOptions {
  /** 'auto' = multilingual mode. NEVER force a single language (PRD §13.2). */
  languageHint: 'auto' | 'hi' | 'mr' | 'en';
  diarize: boolean;
  timeoutMs: number;
  /** seconds; drivers that have per-request limits chunk above this */
  chunkSeconds: number;
}

/** A reference to owned audio storage — a local path at MVP. */
export interface AudioRef {
  storagePath: string;
  durationSec?: number;
}

export interface TranscriptionDriver {
  readonly name: string;
  transcribe(audio: AudioRef, opts: TranscribeOptions): Promise<TranscriptResult>;
}

export class TranscriptionEngineError extends Error {
  constructor(
    message: string,
    readonly engine: string,
    readonly kind: 'timeout' | 'engine' = 'engine',
  ) {
    super(message);
    this.name = 'TranscriptionEngineError';
  }
}

export const DEFAULT_TRANSCRIBE_OPTIONS: Omit<TranscribeOptions, 'timeoutMs' | 'chunkSeconds'> = {
  languageHint: 'auto',
  diarize: true,
};
