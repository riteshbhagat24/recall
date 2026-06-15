# CLAUDE.md — Recall codebase guide

Meeting-intelligence pipeline for Futuready. Node/TypeScript, Fastify API + pg-boss worker,
single Postgres (pgvector). Built from `Futuready_MeetingIntelligence_PRD.md`. Read the PRD for
business intent; this file is the code map and the conventions that aren't obvious from the tree.

## Run / verify

- `docker compose up -d` then `npm run db:setup` (deploy → extras → seed) on an empty DB.
- `npm run dev:api` + `npm run dev:worker` (two processes — PRD Path A).
- `npm run benchmark -- <engine>` — Hinglish gate. `npx tsx scripts/e2e.ts` — full integration.
- `npm run typecheck` before considering anything done.

## Layout

```
src/
  config.ts            validated env (zod). All tunables/limits from the PRD live here.
  db.ts logger.ts audit.ts storage.ts
  adapters/transcription/
    types.ts           TranscriptionDriver contract + TranscriptResult (PRD §11). THE seam.
    mock|sarvam|openai .ts  drivers. index.ts = factory (DB engine_config first, env fallback).
  services/
    structuring.ts     Claude → strict JSON (beta messages.parse + betaZodOutputFormat). Heuristic
                       fallback when no ANTHROPIC_API_KEY so the pipeline runs offline.
    embeddings.ts      provider iface (openai|mock-hash). vectorStore.ts = raw-SQL pgvector I/O.
    search.ts          hybrid keyword(FTS)+semantic(cosine), permission-filtered IN the query.
    contextPack.ts     F8 export. permissions.ts = RBAC + client scope. financial.ts = fin/legal net.
  worker/
    transcribeJob → structureJob → summaryJob  (PRD §8 stages 2–4). main.ts registers + heartbeats.
  pipeline/queues.ts   pg-boss queues + enqueue helpers (one queue per stage).
  api/
    server.ts          Fastify wiring; auth.ts preHandler; routes/*.ts (one per surface).
prisma/schema.prisma   snake_case columns (@map) so raw SQL reads naturally.
prisma/post_migrate.sql  tsvector col + GIN + HNSW (can't be expressed in Prisma — see README).
scripts/               benchmark.ts (gate), e2e.ts (integration), applyExtras.ts.
```

## Conventions / gotchas

- **Never name a speech vendor outside `adapters/transcription/`.** Consume `TranscriptResult`.
- **DB columns are snake_case; Prisma fields camelCase** (via `@map`). Raw SQL uses snake_case.
- **Anthropic SDK is 0.71** — `parse`/`output_config`/`betaZodOutputFormat` live under
  `client.beta.messages` / `@anthropic-ai/sdk/helpers/beta/zod`. Model default `claude-opus-4-8`,
  effort `low|medium|high` (no `max` in this SDK version). See the `claude-api` skill before editing.
- **Financial/Legal lock is the load-bearing invariant.** It's enforced at the query/data layer in:
  search (`services/search.ts`), conversation view + context-pack + L2 summary (financial-blocked
  roles), and segment tags on `transcript_turns`/`embeddings`/`decisions`/`action_items`. If you add
  any surface that returns transcript-derived content, filter it for `design_video`. Verify by
  hitting the API as `x-user-id: 7`, not by checking a UI.
- **Workspace writes never touch shared tables** — by design, there is no such code path. Keep it so.
- **Windows dev gotcha:** `npx tsx ... &` then `kill <pid>` kills the wrapper but not the detached
  node child holding port 3000. Kill the actual listener (`netstat -ano | grep :3000`) when restarting.
- **Prisma migrate drift:** `post_migrate.sql` objects are outside migration history. Don't run
  `migrate dev` on a DB that has them; rebuild from empty with `db:setup`, or add columns via a
  hand-authored migration + `migrate resolve --applied` (see `prisma/migrations/...financial_flags`).

## PRD requirement coverage (selected)

REQ-5.1/11.1 adapter · REQ-4.10 engine swap · REQ-5.2 segment fin/legal · REQ-5.4 permission-filtered
search · REQ-5.5 context pack · REQ-5.6 L2 versioned · REQ-5.7/12.3 workspace read-only-to-shared ·
REQ-5.9/4.9 consent+audit · REQ-12.2 segment-granularity fin/legal at query layer · REQ-16.1 heartbeat.
```
