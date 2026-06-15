import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { toVectorLiteral } from './embeddings.js';

/**
 * pgvector access via raw SQL — the `embedding` column is an Unsupported type in
 * Prisma, so inserts and ANN search go through $queryRaw with explicit ::vector
 * casts. Everything else (the relational rows) uses the typed client.
 */

export interface EmbeddingRow {
  conversationId: number;
  turnId: number | null;
  passageText: string;
  vector: number[];
  modelUsed: string;
  isFinancialLegal: boolean;
}

export async function insertEmbeddings(rows: EmbeddingRow[]): Promise<void> {
  for (const r of rows) {
    await prisma.$executeRaw`
      INSERT INTO embeddings (conversation_id, turn_id, passage_text, embedding, model_used, is_financial_legal, created_at)
      VALUES (${r.conversationId}, ${r.turnId}, ${r.passageText},
              ${toVectorLiteral(r.vector)}::vector, ${r.modelUsed}, ${r.isFinancialLegal}, now())
    `;
  }
}

export interface VectorHit {
  conversation_id: number;
  turn_id: number | null;
  passage_text: string;
  is_financial_legal: boolean;
  score: number;
}

/**
 * Cosine-similarity search over embeddings, permission-filtered BEFORE results
 * leave the DB (REQ-5.4 / REQ-12.2): optional client-id allowlist, and a
 * financial-legal exclusion for Design & Video.
 */
export async function vectorSearch(opts: {
  queryVector: number[];
  limit: number;
  clientIds: number[] | null; // null = unrestricted
  excludeFinancialLegal: boolean;
  conversationClientFilter?: number; // restrict to one client
}): Promise<VectorHit[]> {
  const conds: Prisma.Sql[] = [];
  if (opts.excludeFinancialLegal) {
    conds.push(Prisma.sql`e.is_financial_legal = false`);
  }
  if (opts.clientIds !== null) {
    const ids = opts.clientIds.length ? opts.clientIds : [-1];
    conds.push(Prisma.sql`c.client_id IN (${Prisma.join(ids)})`);
  }
  if (opts.conversationClientFilter != null) {
    conds.push(Prisma.sql`c.client_id = ${opts.conversationClientFilter}`);
  }
  const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;

  const lit = toVectorLiteral(opts.queryVector);
  return prisma.$queryRaw<VectorHit[]>`
    SELECT e.conversation_id, e.turn_id, e.passage_text, e.is_financial_legal,
           1 - (e.embedding <=> ${lit}::vector) AS score
    FROM embeddings e
    JOIN conversations c ON c.id = e.conversation_id
    ${where}
    ORDER BY e.embedding <=> ${lit}::vector
    LIMIT ${opts.limit}
  `;
}
