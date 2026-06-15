import 'dotenv/config';
import { z } from 'zod';

/**
 * Central, validated configuration. Anything vendor-specific or tunable in the
 * PRD lives here so the rest of the code reads from one typed object.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_PORT: z.coerce.number().default(3000),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  STORAGE_ROOT: z.string().default('./storage'),

  // Transcription adapter
  TRANSCRIPTION_ENGINE: z.enum(['mock', 'sarvam', 'openai']).default('mock'),
  SARVAM_API_KEY: z.string().optional(),
  SARVAM_BASE_URL: z.string().default('https://api.sarvam.ai'),
  OPENAI_API_KEY: z.string().optional(),
  TRANSCRIBE_CHUNK_SECONDS: z.coerce.number().default(1800),
  TRANSCRIBE_TIMEOUT_MS_PER_HOUR: z.coerce.number().default(600_000),

  // Claude
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-opus-4-8'),
  // SDK 0.71 effort type accepts low|medium|high. `max` exists on newer SDKs.
  CLAUDE_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),

  // Embeddings
  EMBEDDING_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIM: z.coerce.number().default(1536),

  // Limits
  UPLOAD_MAX_BYTES: z.coerce.number().default(1_073_741_824),
  MIN_AUDIO_SECONDS: z.coerce.number().default(30),
  CONTEXT_PACK_TOKEN_BUDGET: z.coerce.number().default(6000),
  WORKER_HEARTBEAT_STALE_MS: z.coerce.number().default(300_000),

  DEV_AUTH_TRUST_HEADER: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  // Optional shared-password gate (HTTP Basic) for the WHOLE app. Set on any
  // public deployment so a link isn't wide open — this is a team-access gate in
  // FRONT of the (still header-based) role model, NOT a replacement for real
  // per-user auth. Format: "user:password". Empty = no gate (local dev).
  BASIC_AUTH: z.string().optional(),
});

export const config = schema.parse(process.env);
export type Config = typeof config;

/**
 * Engine selection note: TRANSCRIPTION_ENGINE here is the env default. At runtime
 * the admin-settable engine_config.TRANSCRIPTION_ENGINE row takes precedence
 * (PRD F10, REQ-4.10). The adapter factory resolves DB-first, env-fallback.
 */
export const ALLOWED_UPLOAD_MIME = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

export const ALLOWED_UPLOAD_EXT = new Set([
  'mp3',
  'm4a',
  'wav',
  'aac',
  'mp4',
  'mov',
  'webm',
]);
