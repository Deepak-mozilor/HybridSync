# HybridSync

An AI-powered hybrid work scheduling assistant that lives inside Slack. HybridSync tracks where your team is working each day, surfaces collaboration conflicts, and proactively nudges people to align their schedules — all without leaving Slack.

---

## What it does

- **Status detection** — Post `wfh`, `in office`, `sick`, or `on leave` in any channel and HybridSync registers it using Claude AI (handles negations, non-English messages, questions about others — no false positives)
- **Slack profile sync** — Status changes automatically update the user's Slack profile emoji and text for the day
- **App Home dashboard** — Each user gets a personal schedule view with their week, anchor days, best collaboration day, and core collaborator status
- **AI chatbot** — DM the HybridSync bot to query schedules, find teammates, or update your own status in natural language
- **Smart notifications** — When a high-dependency colleague changes location, affected teammates get a DM with one-tap response buttons
- **AI orchestrator** — A ReAct agent runs after each status change, analyses the dependency graph, and coordinates schedule adjustments
- **Admin dashboard** — React web app with role-based login (HR and Manager views), dependency graph visualization, schedule grid, and anchor day management

---

## Architecture

```
hybridsync-backend/          Node.js + Slack Bolt SDK (Socket Mode)
├── listeners/
│   ├── stream.js            Channel messages → Haiku classifier → DB + Slack sync
│   ├── appHome.js           App Home open event → publish personalized view
│   ├── chatbot.js           DM chatbot listener (conversation history per user)
│   └── slackStatusSync.js   Detect external Slack profile changes (don't overwrite custom)
├── views/
│   ├── appHome.js           Block Kit App Home builder — runs in two Promise.all batches
│   ├── overrideModal.js     Edit schedule modal (Mon–Fri × WFH/Office/Sick/Leave)
│   └── manageDepsModal.js   Add/remove/score collaborators modal
├── actions/
│   ├── override.js          Override modal submit → DB → App Home refresh
│   ├── negotiation.js       DM button responses (Switch WFH / Stay Office)
│   ├── manageDeps.js        Manage dependencies modal
│   └── disconnect.js        Disconnect Google Calendar / Slack Status Sync buttons
├── ai/
│   ├── orchestrator.js      Claude Opus ReAct loop — dependency analysis + coordination
│   ├── chatbot.js           Claude agent with 6 tools for DM schedule queries
│   ├── provider.js          Anthropic ↔ Groq abstraction with auto-fallback + token logging
│   └── batch.js             Cron jobs — weekly mapping (Sun 2AM UTC), daily status sync
│                            (Mon-Fri 8AM IST), Google channel renewal (daily 3AM UTC)
├── services/
│   ├── teamSync.js          Slack channels → teams sync
│   ├── slackStatus.js       Push HybridSync status to Slack profiles
│   ├── googleCalendar.js    Google Calendar OAuth, events.watch, meeting-load classifier
│   ├── notifications.js     DM dependents when a collaborator changes status
│   └── calendarAlerts.js    Flag WFH conflicts when calendar shows in-person meetings
├── db/
│   ├── index.js             Supabase (Postgres) data layer with bulk fetchers
│   └── schema.sql           6 tables — workspaces, users, teams, overrides, dependencies,
│                            team_members. Multi-tenant via workspace_id. RLS enabled.
│                            Applied manually in the Supabase SQL editor (idempotent).
├── server.js                Express REST API on :3001 — dashboard + OAuth callback +
│                            /slack/install + /api/google/* + /healthz
├── instrument.js            Sentry wiring (loaded at boot)
└── app.js                   Entry point — registers all modules + starts cron

hybridsync-frontend/         React + Vite admin dashboard
├── src/views/
│   ├── LoginPage.jsx        Role-based login (HR Admin / Team Manager)
│   ├── GodView.jsx          HR view — all users, stat cards, dependency graph
│   └── SquadView.jsx        Manager view — team schedule grid + anchor day editor
└── src/components/
    ├── GraphView.jsx         React Flow dependency graph
    ├── ScheduleGrid.jsx      Week schedule table
    └── AnchorEditor.jsx      Anchor day picker per team
```

---

## AI models used

| Component | Primary | Fallback / retry | Why |
|---|---|---|---|
| Status classifier (Stream) | Claude Haiku 4.5 ×3 | Claude Sonnet 4.6 ×1 | Cheap, fast — runs on every channel message; Sonnet kicks in on Haiku overload |
| DM chatbot | Claude Opus 4.7 + adaptive thinking | Groq `gpt-oss-120b` | Tool use over 6 schedule tools; falls back when Anthropic is unreachable |
| Orchestrator | Claude Opus 4.7 | — | ReAct loop with adaptive thinking |
| Weekly dependency mapping | Claude Opus 4.7 | Groq `gpt-oss-120b` | Single JSON-only call; tolerates fallback |

Prompt caching (`cache_control: ephemeral`) is applied to system prompt + tool definitions on Anthropic calls — iteration 2+ of the agent loop and any chat within ~5 min reads tools at ~10% billing rate. Token usage is logged per call to Railway stdout as `[AI:<label>/<provider>] tokens — …`. Groq model is env-overridable via `GROQ_MODEL`.

---

## Tech stack

- **Backend**: Node.js, Slack Bolt SDK (Socket Mode), Express
- **Database**: Supabase (Postgres)
- **AI**: Anthropic Claude API (`@anthropic-ai/sdk`)
- **Frontend**: React, Vite, React Flow
- **Auth**: JWT (`jsonwebtoken`)

---

## Getting started

### Prerequisites
- Node.js 18+
- A Slack workspace with a Slack app (Socket Mode enabled)
- Supabase project
- Anthropic API key

### Backend setup

```bash
cd hybridsync-backend
npm install
```

Copy `.env.example` to `.env` and fill in:

```env
# Slack — bot token is no longer hard-coded; it's pulled per-workspace
# from the workspaces table after the OAuth install flow.
SLACK_APP_TOKEN=xapp-...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_OAUTH_REDIRECT_URI=http://localhost:3001/api/oauth/callback

# Database
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...   # service_role key, not anon

# AI — at least one of these must be set
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...          # fallback when Anthropic fails; chatbot + batch only
GROQ_MODEL=openai/gpt-oss-120b  # optional, swap without redeploy

# Dashboard auth
JWT_SECRET=your-secret
HR_PASSWORD=hr@hybridsync
MANAGER_PASSWORD=manager@hybridsync

# Google Calendar (optional — per-user OAuth for meeting-load awareness)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Observability (optional)
SENTRY_DSN=...
```

Run the DB schema in the Supabase SQL editor (`db/schema.sql`), then:

```bash
node app.js
```

### Frontend setup

```bash
cd hybridsync-frontend
npm install
npm run dev
```

Dashboard runs at `http://localhost:5173`. Default credentials:
- HR Admin: password `hr@hybridsync`
- Team Manager: password `manager@hybridsync`

### Slack app required scopes

**Bot token scopes:** `channels:history`, `channels:read`, `chat:write`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `reactions:write`, `users:read`, `users:read.email`

**User token scopes:** `users.profile:write`

**Event subscriptions:** `message.channels`, `message.groups`, `message.im`, `app_home_opened`, `member_joined_channel`

### Slack status sync (optional)

Users can connect their Slack account from the App Home to enable automatic Slack profile status updates. Requires a public HTTPS redirect URI — use ngrok for local development:

```bash
ngrok http 3001
# Update SLACK_OAUTH_REDIRECT_URI in .env and in Slack app OAuth settings
```

---

## Key features in detail

### Smart status detection
Uses Claude Haiku to classify channel messages. Handles edge cases cleanly:
- `"not wfh today"` → sets **Office**
- `"who is wfh?"` → ignored (question about others)
- `"ellaverum office ah?"` → ignored (non-English question)

### Best collaboration day
Analyses each user's week schedule against their top collaborators' schedules and surfaces the day with the highest weighted co-location score.

### Dependency graph
Directed weighted graph (score 1–10) between users. High-score pairs (≥7) get proactive DM nudges when their schedules diverge. Visualised as a node network in the admin dashboard.

### ReAct orchestrator
Runs non-blocking after each status change. Uses a Reason→Act→Observe loop with three tools: read dependency graph, send negotiation DM, update schedule in DB.
