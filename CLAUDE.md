# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Monorepo with two independent Node packages:

- `hybridsync-backend/` — Express + Slack Bolt + node-cron, all in one process. Entry: `app.js`.
- `hybridsync-frontend/` — React + Vite admin dashboard. Entry: `src/main.jsx`.
- `db/schema.sql` lives **inside** `hybridsync-backend/` but is applied **manually** in the Supabase SQL editor. Editing the file does not migrate the live DB — paste the new statements yourself. All `CREATE INDEX` / `ALTER TABLE` statements are idempotent (`IF NOT EXISTS`), so re-running the whole file is safe.

## Common commands

Run from `hybridsync-backend/` unless noted:

```bash
npm run dev                       # node --watch app.js — auto-restart on changes
npm start                         # production-style boot
npm test                          # jest (tests in tests/**/*.test.js)
npm test -- <pattern>             # single test by file/name regex
npm run run:weekly-mapping        # manually trigger the Sunday-2AM dependency rebuild
npm run run:daily-status-sync     # manually trigger the Mon-Fri-8AM-IST Slack status push
```

Frontend (`hybridsync-frontend/`):
```bash
npm run dev                       # vite on :5173
npm run lint                      # eslint .
npm test                          # vitest run
```

Deploy (from repo **root**, not from `hybridsync-backend/` — Railway's Root Directory mismatch will reject otherwise):
```bash
railway up
```

## Architecture — things that require reading multiple files

### Multi-tenancy
Every tenant table (`users`, `teams`, `overrides`, `dependencies`, `team_members`) carries a `workspace_id`. RLS is enabled as defence in depth, but the backend uses the Supabase service-role key and bypasses it. Tenant isolation is enforced in JS by:
1. JWT carries `workspaceId` (`server.js requireAuth`).
2. Workspace-scoped helpers like `getAllUsers(workspaceId)` filter at the SQL layer.
3. Bulk fetchers (`getSchedulesForUsers`, `getUsers`, `getUserTokens`, `getUserTeamsMap`) take **id lists, not workspaceId** — callers must guarantee the ids already come from a workspace-scoped query. Don't introduce a caller that passes unsanitised ids.

### AI provider abstraction (`ai/provider.js`)
- Two providers, one interface. `ANTHROPIC_API_KEY` wins if set; else `GROQ_API_KEY`.
- Automatic fallback Anthropic → Groq on 401 / 403 / 429 / 5xx / network. **Critical:** the fallback path checks `err.noFallback`. `runWithAnthropic` sets this when a side-effectful tool has already executed in the current loop — otherwise Groq would re-emit `set_my_status` and cause duplicate orchestrator messages + double `notifyDependents` DMs. Any new mutating tool inherits this guard for free.
- Groq model is env-overridable: `GROQ_MODEL` (default `openai/gpt-oss-120b`). Avoid `llama-3.3-70b-versatile` — it emits legacy `<function=...>` syntax that trips Groq's parser on tool-heavy prompts.
- Token usage logs via `logUsage(provider, totals, label?)`. Tag format: `[AI:<label>/<provider>] tokens — …`. Pass `label` from cron / batch contexts so logs are filterable.

### The Stream is a special case
`listeners/stream.js` (channel-message status classifier) **bypasses** the provider abstraction — it constructs Anthropic directly at module load and has its own multi-attempt schedule (Haiku 4.5 ×3 → Sonnet 4.6 ×1). Consequences: no Groq fallback, no tagged token logging, no `cache_control` on tools. This is the highest-volume AI path; centralising it through `provider.js` is a known cleanup target.

### N+1 → bulk pattern
Every loop over users that previously did `await db.getX(u.id)` has been converted to one bulk `SELECT … IN (ids)` + JS-side grouping. Pattern:
- Bulk fn lives next to its single-row sibling in `db/index.js`.
- Returns `Map<id, value>`; missing ids are absent (except `getSchedulesForUsers`, which intentionally produces an empty array for every requested id).
- Callers use `.get(id) || defaultValue` synchronously after one `await`.

If you write a new handler that hits the DB per user in a loop, look for an existing bulk variant first.

### App Home (`views/appHome.js buildHomeView`)
Two `Promise.all` fan-outs, three round trips total regardless of workspace size:
1. `await ensureUser` — must complete first (creates the row on first-time users).
2. First batch — schedule, deps, tokens, manager status.
3. Second batch — peer schedules, peer users, weekly meeting load.

Adding new data to App Home: figure out which batch it belongs in based on its data dependencies; do **not** add a serial `await` between batches.

### Cron registration
All cron jobs in `ai/batch.js start()`:
- Weekly mapping — Sun 02:00 UTC — rebuild dependency graph.
- Daily status sync — Mon-Fri 02:30 UTC (08:00 IST) — push HybridSync status to Slack profiles.
- Google channel renewal — daily 03:00 UTC — renew `events.watch` webhooks before their 7-day TTL.

Cron errors fan out to both stdout and Sentry (`reportCronError`).

### Slack OAuth on Socket Mode + Railway
Bolt's built-in install server is unreachable behind single-port platforms like Railway. The OAuth routes (`/slack/install`, `/api/oauth/callback`) are hosted on the existing Express server in `server.js`, not on Bolt's separate install port. Don't switch back to Bolt's built-in installer.

## Collaboration norms

- **Don't commit unless asked.** Even after a clean refactor.
- **Don't auto-restart local dev servers (backend, ngrok).** The user controls server lifecycle.
- **Phased commits, not mega-PRs.** Big refactors get split into themed commits with clear scope per commit.
- **`schema.sql` changes need a human in the Supabase SQL editor** — call this out explicitly when adding `CREATE INDEX` / `ALTER TABLE` statements.

## Outdated information to ignore

- `README.md` describes the Stream as regex-only — it has been AI-classified for a while now.
- `hybridsync_master_context.md` mentions Firebase as the database. The real DB is Supabase Postgres. The doc is a historical artefact from the hackathon kickoff; do not treat it as source of truth.
- `ARCHITECTURE.html` at the repo root is the current end-to-end diagram (data flows, AI pipeline, DB indexes, bulk fetchers). Update it when the data flows change.
