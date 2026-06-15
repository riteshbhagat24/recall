import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Embedding provider behind a tiny interface so it is swappable like the speech
 * engine. 'mock' produces deterministic vectors (hashed) so the whole semantic-
 * search path runs locally with no API key; 'openai' uses a real embedding model.
 * Dimension MUST equal EMBEDDING_DIM and the pgvector column width.
 */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'mock-hash';
  constructor(readonly dim: number) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => deterministicVector(t, this.dim));
  }
}

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  constructor(
    readonly model: string,
    readonly dim: number,
  ) {
    this.client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dim,
    });
    return res.data.map((d) => d.embedding as number[]);
  }
}

let provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (provider) return provider;
  if (config.EMBEDDING_PROVIDER === 'openai' && config.OPENAI_API_KEY) {
    provider = new OpenAIEmbeddingProvider(config.EMBEDDING_MODEL, config.EMBEDDING_DIM);
  } else {
    if (config.EMBEDDING_PROVIDER === 'openai') {
      logger.warn('EMBEDDING_PROVIDER=openai but OPENAI_API_KEY missing; using mock embeddings');
    }
    provider = new MockEmbeddingProvider(config.EMBEDDING_DIM);
  }
  return provider;
}

/** Deterministic pseudo-embedding: stable per-text, normalized. Dev/test only. */
function deterministicVector(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  // simple bag-of-chars hashing into buckets, then L2-normalize
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const bucket = (code * 31 + i) % dim;
    v[bucket] = (v[bucket] ?? 0) + 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** pgvector literal: `[0.1,0.2,...]`. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
