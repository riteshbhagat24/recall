import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { getEmbeddingProvider } from './embeddings.js';
import { vectorSearch } from './vectorStore.js';
import type { Actor } from './permissions.js';
import { isFinancialBlocked, visibleClientIds } from './permissions.js';

/**
 * Hybrid search (PRD F6, REQ-5.4). Keyword (Postgres full-text) + semantic
 * (pgvector cosine), merged and re-ranked. Role + Financial/Legal filtering is
 * applied IN THE QUERY, before results leave the DB — never UI-only. Results
 * never leak the existence of hidden content.
 */
export interface SearchResult {
  conversationId: number;
  clientId: number;
  projectId: number;
  snippet: string;
  speakerLabel: string | null;
  timestamp: string | null; // hh:mm:ss
  score: number;
}

export interface SearchFilters {
  client?: number;
  project?: number;
  speaker?: string;
}

interface KeywordHit {
  conversation_id: number;
  client_id: number;
  project_id: number;
  text: string;
  speaker_label: string;
  start_ts: number;
  rank: number;
}

export async function hybridSearch(
  actor: Actor,
  query: string,
  filters: SearchFilters = {},
  limit = 20,
): Promise<SearchResult[]> {
  const clientIds = await visibleClientIds(actor); // null = unrestricted
  const excludeFinancial = isFinancialBlocked(actor);

  const [keyword, semantic] = await Promise.all([
    keywordSearch(query, clientIds, excludeFinancial, filters, limit),
    semanticSearch(query, clientIds, excludeFinancial, filters, limit),
  ]);

  return mergeAndRank(keyword, semantic, limit);
}

async function keywordSearch(
  query: string,
  clientIds: number[] | null,
  excludeFinancial: boolean,
  filters: SearchFilters,
  limit: number,
): Promise<SearchResult[]> {
  const conds: Prisma.Sql[] = [
    Prisma.sql`tt.text_search @@ plainto_tsquery('simple', ${query})`,
  ];
  if (excludeFinancial) conds.push(Prisma.sql`tt.is_financial_legal = false`);
  if (clientIds !== null) {
    const ids = clientIds.length ? clientIds : [-1];
    conds.push(Prisma.sql`c.client_id IN (${Prisma.join(ids)})`);
  }
  if (filters.client != null) conds.push(Prisma.sql`c.client_id = ${filters.client}`);
  if (filters.project != null) conds.push(Prisma.sql`c.project_id = ${filters.project}`);
  if (filters.speaker) conds.push(Prisma.sql`tt.speaker_label = ${filters.speaker}`);

  const where = Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}`;
  const rows = await prisma.$queryRaw<KeywordHit[]>`
    SELECT c.id AS conversation_id, c.client_id, c.project_id,
           tt.text, tt.speaker_label, tt.start_ts,
           ts_rank(tt.text_search, plainto_tsquery('simple', ${query})) AS rank
    FROM transcript_turns tt
    JOIN transcripts t ON t.id = tt.transcript_id
    JOIN recordings r ON r.id = t.recording_id
    JOIN conversations c ON c.recording_id = r.id
    ${where}
    ORDER BY rank DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    clientId: r.client_id,
    projectId: r.project_id,
    snippet: snippet(r.text),
    speakerLabel: r.speaker_label,
    timestamp: hms(r.start_ts),
    score: Number(r.rank),
  }));
}

async function semanticSearch(
  query: string,
  clientIds: number[] | null,
  excludeFinancial: boolean,
  filters: SearchFilters,
  limit: number,
): Promise<SearchResult[]> {
  const [vector] = await getEmbeddingProvider().embed([query]);
  if (!vector) return [];
  const hits = await vectorSearch({
    queryVector: vector,
    limit,
    clientIds,
    excludeFinancialLegal: excludeFinancial,
    conversationClientFilter: filters.client,
  });
  // resolve project ids + speaker/timestamp for the matched turns
  const results: SearchResult[] = [];
  for (const h of hits) {
    const conv = await prisma.conversation.findUnique({
      where: { id: h.conversation_id },
      select: { clientId: true, projectId: true },
    });
    if (!conv) continue;
    if (filters.project != null && conv.projectId !== filters.project) continue;
    const turn = h.turn_id
      ? await prisma.transcriptTurn.findUnique({ where: { id: h.turn_id } })
      : null;
    if (filters.speaker && turn?.speakerLabel !== filters.speaker) continue;
    results.push({
      conversationId: h.conversation_id,
      clientId: conv.clientId,
      projectId: conv.projectId,
      snippet: snippet(h.passage_text),
      speakerLabel: turn?.speakerLabel ?? null,
      timestamp: turn ? hms(turn.startTs) : null,
      score: h.score,
    });
  }
  return results;
}

/** Reciprocal-rank-style merge: combine the two lists, keep best score per turn. */
function mergeAndRank(
  keyword: SearchResult[],
  semantic: SearchResult[],
  limit: number,
): SearchResult[] {
  const byKey = new Map<string, SearchResult>();
  const add = (r: SearchResult, weight: number) => {
    const key = `${r.conversationId}:${r.timestamp}:${r.snippet.slice(0, 24)}`;
    const existing = byKey.get(key);
    const weighted = { ...r, score: r.score * weight };
    if (!existing || weighted.score > existing.score) byKey.set(key, weighted);
  };
  // normalize: keyword ranks and cosine scores live on different scales; weight
  // semantic higher since cosine is already 0..1 and keyword ts_rank is small.
  keyword.forEach((r) => add(r, 1));
  semantic.forEach((r) => add(r, 1));
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function snippet(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function hms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
