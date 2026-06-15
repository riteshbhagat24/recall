# Recall — Futuready Meeting Intelligence & Knowledge Base

Multilingual transcription → structured knowledge → governed team memory.

This is the **MVP pipeline spine** from `Futuready_MeetingIntelligence_PRD.md`, built per the
PRD's build sequencing: **capture (upload) → transcribe → structure → KB → search**, with the
swappable transcription adapter de-risked first and the benchmark gate runnable from day one.

> **Stack note.** The PRD specifies Laravel/PHP for continuity with the onboarding tool. This
> build targets **Node/TypeScript** (chosen at kickoff) because the host has Node + Docker and no
> PHP toolchain, and the onboarding codebase it would share a backbone with is not present here.
> The architecture, data model, and every requirement (`[REQ-x.x]`) map 1:1 to the PRD — only the
> language differs. The shared-backbone tables (clients/projects/users/roles) are modelled locally
> (PRD §7); in production they are owned by onboarding and referenced by ID.

## Architecture (maps to PRD §8)

```
Capture (upload)  →  Transcribe        →  Structure              →  Memory            →  Consume
 POST /recordings     adapter:             Claude (JSON schema)       L2 living            search · auto-outputs
 + consent gate       Sarvam/OpenAI/Mock   summary/actions/           summaries            · context-pack
                      → TranscriptResult   decisions/tags             (versioned)          · private workspaces
                                           + segment fin/legal tag
                                           + pgvector embeddings
        └────────────── pg-boss queues (one per stage, retries + backoff) ──────────────┘
```

- **One DB**: Postgres + pgvector serves relational data, embeddings, **and** the pg-boss queue
  (no Redis). On the VPS this maps 1:1.
- **Swappable engine** (PRD F3/§11): the only code that knows a speech vendor is one
  `TranscriptionDriver` behind `transcribe()`. Switch via `engine_config.TRANSCRIPTION_ENGINE`
  (admin API) — nothing downstream changes. Drivers: `mock`, `sarvam`, `openai`.
- **Two non-negotiables, enforced at the data layer (not UI):**
  1. **Financial/Legal lock** at *segment* granularity — transcript turns, embeddings, and derived
     decisions/action-items are tagged; Design & Video never receive financial content through
     transcript, search, conversation view, context-pack, or living summary.
  2. **Workspace isolation** — `workspace_items` are per-user; no API path writes into shared tables.

## Prerequisites

- Node ≥ 20, Docker (for Postgres+pgvector).

## Setup

```bash
cp .env.example .env                 # mock engine + heuristic structuring work with NO API keys
docker compose up -d                 # Postgres + pgvector on :5433

npm install
npm run db:deploy                    # apply migrations
npm run db:extras                    # tsvector column + GIN/HNSW indexes (see "Migrations" below)
npm run db:seed                      # engine config + 2 clients + 2 projects + 1 user per role

# two processes (PRD Path A: app + VPS worker)
npm run dev:worker                   # pipeline worker (supervisor-managed in prod)
npm run dev:api                      # JSON API on :3000
```

### Dashboard

Open **http://localhost:3000/** — a single-page UI (served by the API) for the §6 surfaces:
a **role switcher** (top-right) that re-scopes everything server-side, one-click upload with live
`captured → … → ready` status, the Client→Project→Conversation browser, conversation detail
(summary/actions/decisions/transcript), search, context-pack export, and an admin tab
(engine config + review queue). Switch between **Super Admin** and **Design & Video** on the same
conversation to watch the Financial/Legal lock add/remove content live.

With no `ANTHROPIC_API_KEY`/engine keys, the system runs fully on the **mock** engine + a
deterministic heuristic structurer, so the whole pipeline reaches `ready` offline. Add real keys
and flip `TRANSCRIPTION_ENGINE`/`EMBEDDING_PROVIDER`/`ANTHROPIC_API_KEY` for production behavior.

## Verify it works

```bash
npm run benchmark -- mock            # the Hinglish benchmark gate (PRD US-3); add real calls to benchmark/cases
npx tsx scripts/e2e.ts               # 21-check end-to-end: pipeline + financial-lock + workspace isolation + RBAC
```

The e2e proves the two non-negotiables by calling the search/export APIs **directly as the Design
role** (not via UI), per the PRD's "hold the line" instruction.

## Dev auth

Production reuses onboarding's session auth (PRD §12). Locally the API trusts an `x-user-id`
header resolved against seeded users:

| id | role | notes |
|----|------|-------|
| 1 | super_admin | full access |
| 2 | admin_cs_lead | edit + config |
| 3 | bd | view/export + config |
| 4 | finance | sees financial |
| 5 | cs | upload/edit |
| 6 | performance | **scoped to client 1 (Acme) only** |
| 7 | design_video | **never sees Financial/Legal content** |

## Key endpoints (PRD §11)

`POST /recordings/upload` · `GET /recordings/{id}/status` · `POST /recordings/{id}/consent` ·
`POST /recordings/{id}/retry` · `GET /conversations/{id}` · `PUT /conversations/{id}/outputs` ·
`GET /search` · `GET /clients/{id}/summary` · `GET /projects/{id}/context-pack` ·
`GET|POST|PUT|DELETE /workspace[/items]` · `GET|POST /admin/engine-config` ·
`GET /admin/review-queue` · `GET /health`

## Migrations note

pgvector ANN indexes and the generated `tsvector` full-text column can't be expressed in Prisma's
schema language, so they live in `prisma/post_migrate.sql`, applied by `npm run db:extras` **after**
`db:deploy`. Because these objects are outside Prisma's migration history, do **not** run
`prisma migrate dev` against a DB that already has them (it reports drift and wants a reset). For a
clean rebuild use `npm run db:setup` (deploy → extras → seed) on an empty database.

## What's built vs. PRD scope

**Built (MVP spine + governance):** upload capture, swappable adapter (3 drivers), 4-stage queued
pipeline, Claude structuring with strict JSON + retry→review-queue, segment-level Financial/Legal
tagging, KB hierarchy, hybrid keyword+vector search, L2 living summaries, private workspaces,
context-pack export, consent + audit, admin engine-config + review queue, heartbeat/health,
benchmark gate.

**Stubbed/Phase-2 (per PRD non-goals):** Google Meet bot (`/recordings/meet` returns 501 — upload
is the always-available path, REQ-14.1), named-speaker mapping, real-time transcription, self-hosted
Whisper, auto topic-clustering.

See `CLAUDE.md` for the file-by-file map and PRD requirement coverage.
