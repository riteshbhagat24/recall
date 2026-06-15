# Deploying Recall for internal review

**Why not Vercel/serverless:** Recall has an always-on **pipeline worker** (continuously polls a
queue) and needs **Postgres + pgvector** and file storage. Serverless platforms (Vercel, Netlify
Functions, cPanel) can't run a persistent worker — the same reason the PRD (§9) mandates a VPS.
Use a platform that runs always-on services: **Render, Railway, Fly.io, or any VPS**.

## Render (one blueprint, ~10 min)

Render reads `render.yaml` and provisions Postgres + the API (web) + the worker.

1. **Push this repo to GitHub** (it isn't a git repo yet):
   ```bash
   git init && git add -A && git commit -m "Recall MVP"
   git remote add origin <your-repo-url> && git push -u origin main
   ```
2. **Render → New + → Blueprint → pick the repo.** It detects `render.yaml`.
3. **Set `BASIC_AUTH`** in the Render dashboard to a shared team password, e.g. `team:somephrase`.
   This gates the whole site (there's no per-user login yet — Phase 2). `/health` stays open for
   Render's health check.
4. (Optional) add `ANTHROPIC_API_KEY` / `SARVAM_API_KEY` / `OPENAI_API_KEY` and switch
   `TRANSCRIPTION_ENGINE`/`EMBEDDING_PROVIDER` off `mock` for real transcription + structuring.
5. Deploy. Render gives you `https://recall-api-XXXX.onrender.com` — share that + the password.

**Notes**
- Render's managed Postgres supports the `vector` extension; migrations + `post_migrate.sql` create
  it. If your DB doesn't, point `DATABASE_URL` at Neon (pgvector built in) instead.
- Free Postgres expires after 30 days; free web/worker services sleep when idle (first request after
  idle is slow). Fine for review; upgrade for anything ongoing.
- Audio storage is ephemeral on free instances — fine for the `mock` demo (it doesn't read the
  uploaded bytes). For real engines, attach a Render persistent disk or move storage to S3/Blob.

## Railway / Fly.io / VPS
Same Dockerfile. Run two processes — `node dist/src/api/server.js` (web) and
`node dist/src/worker/main.js` (worker) — against one Postgres+pgvector, with `npm run prod:release`
once per deploy for migrations. Set `BASIC_AUTH` and `DATABASE_URL`.

## Security reminder
A hosted URL is only as safe as `BASIC_AUTH` until real per-user authentication (PRD §12, Phase 2)
replaces the dev `x-user-id` role shim. Don't put **real** client meetings behind it before then —
keep hosted demos on `mock`/seeded data.
