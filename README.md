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
│   ├── stream.js            Channel messages → AI status classification → DB + Slack sync
│   ├── appHome.js           App Home open event → publish personalized view
│   └── chatbot.js           DM chatbot with conversation history
├── views/
│   ├── appHome.js           Block Kit App Home builder (schedule, best collab day, collaborators)
│   ├── overrideModal.js     Edit schedule modal (Mon–Fri × WFH/Office/Sick/Leave)
│   └── manageDepsModal.js   Add/remove/score collaborators modal
├── actions/
│   ├── override.js          Override modal submit → DB → App Home refresh
│   ├── negotiation.js       DM button responses (Switch WFH / Stay Office)
│   └── manageDeps.js        Manage dependencies modal
├── ai/
│   ├── orchestrator.js      Claude Opus ReAct loop — dependency analysis + schedule coordination
│   ├── chatbot.js           Claude agent with 4 tools for DM schedule queries
│   ├── provider.js          Anthropic/Groq abstraction with tool-use loop
│   └── batch.js             Cron jobs — daily sweep (7AM) + weekly dep mapping (Sun 2AM)
├── services/
│   ├── teamSync.js          Slack channels → teams sync
│   └── slackStatus.js       Slack profile status sync via user OAuth token
├── db/
│   ├── index.js             Supabase (Postgres) data layer
│   └── schema.sql           4-table schema — users, teams, overrides, dependencies
├── server.js                Express REST API on :3001 for the React dashboard + OAuth callback
└── app.js                   Entry point — registers all modules

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

| Component | Model | Why |
|---|---|---|
| Status classifier | Claude Haiku 4.5 | Cheap, fast — runs on every channel message |
| DM chatbot | Claude Opus 4.7 | Full reasoning for schedule queries + tool use |
| Orchestrator | Claude Opus 4.7 | ReAct loop with adaptive thinking |

Prompt caching is used on static system prompts to reduce token costs.

---

## Tech stack

- **Backend**: Node.js, Slack Bolt SDK (Socket Mode), Express
- **Database**: Supabase (Postgres)
- **AI**: Anthropic Claude API (`@anthropic-ai/sdk`)
- **Frontend**: React, Vite, React Flow
- **Auth**: JWT (`jsonwebtoken`)

---

## Live deployment

- **Dashboard:** <https://hybrid-sync.vercel.app>
- **Backend:** <https://hybridsync-backend-production.up.railway.app>

The frontend is hosted on Vercel, the backend + Slack Bolt + cron jobs on Railway, and the database on Supabase. No local setup is needed to use the product.

## Signing in

The dashboard uses **Sign in with Slack** (OpenID Connect) — there are no usernames or passwords.

1. Open the dashboard at <https://hybrid-sync.vercel.app>.
2. Click **Sign in with Slack** and approve the consent screen.
3. Your role (Admin / Manager / User) and team scope are taken from your Slack identity and the HybridSync user record in the workspace you belong to. Admins see the full organisation; managers see their team.

If your workspace hasn't installed the Slack app yet, use **+ Add HybridSync to your Slack workspace** on the login screen — that flow is at `/slack/install` on the backend.

### Slack app required scopes

**Bot token scopes:** `channels:history`, `channels:read`, `chat:write`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `reactions:write`, `users:read`, `users:read.email`

**User token scopes:** `users.profile:write`

**Event subscriptions:** `message.channels`, `message.groups`, `message.im`, `app_home_opened`, `member_joined_channel`

### Connecting your own Slack profile / Google Calendar

From the HybridSync App Home tab in Slack, use:
- **Connect Slack Status** — lets HybridSync update your Slack profile emoji to match your hybrid-work status.
- **Connect Google Calendar** — adds meeting-load awareness to your schedule and the chatbot's recommendations.

Both flows go through the deployed backend's OAuth callback; nothing on your machine is required.

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
