-- HybridSync — Supabase schema
-- Run this once in the Supabase SQL editor before starting the app.

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  team_id      TEXT,
  role         TEXT NOT NULL DEFAULT 'employee',
  week         JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  anchor_days TEXT[] NOT NULL DEFAULT '{}',
  manager_id  TEXT
);

-- Per-date status overrides (takes priority over the weekly default in users.week)
CREATE TABLE IF NOT EXISTS overrides (
  user_id  TEXT NOT NULL,
  date_key TEXT NOT NULL,   -- YYYY-MM-DD
  status   TEXT NOT NULL CHECK (status IN ('WFH', 'Office', 'Sick', 'Leave')),
  PRIMARY KEY (user_id, date_key)
);

-- Directed dependency edges  (user_id depends on peer_id at this score)
CREATE TABLE IF NOT EXISTS dependencies (
  user_id TEXT    NOT NULL,
  peer_id TEXT    NOT NULL,
  score   INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
  PRIMARY KEY (user_id, peer_id)
);

-- Slack OAuth user token (run this if upgrading an existing DB)
ALTER TABLE users ADD COLUMN IF NOT EXISTS slack_user_token TEXT;

-- Manual dependency flag — preserves hand-set scores across AI recalculations
ALTER TABLE dependencies ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT FALSE;

-- Google Calendar OAuth tokens, email, and webhook channel
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_tokens         JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_email          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_channel_id     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_channel_expiry BIGINT;

-- Role column already exists above; ensure default for any pre-existing rows
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'employee';

-- Slack workspace installations — one row per workspace that installs the app.
-- Bolt's installationStore reads/writes the `installation` JSONB to recover
-- the per-team bot token at runtime.
CREATE TABLE IF NOT EXISTS workspaces (
  id                TEXT PRIMARY KEY,        -- Slack team_id (T0XXXXX)
  name              TEXT NOT NULL,
  bot_token         TEXT NOT NULL,
  bot_user_id       TEXT,
  installer_user_id TEXT NOT NULL,
  installation      JSONB NOT NULL,
  installed_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Multi-team membership. users.team_id is kept as a back-compat "primary team"
-- pointer; team_members is the source of truth when a user is in multiple
-- Slack channels (= multiple teams).
CREATE TABLE IF NOT EXISTS team_members (
  user_id    TEXT NOT NULL,
  team_id    TEXT NOT NULL,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX IF NOT EXISTS team_members_team_idx ON team_members(team_id);

-- ---------------------------------------------------------------------------
-- Multi-tenancy — workspace_id on every tenant-scoped table.
-- Idempotent: safe to re-run on a partially-migrated DB.
-- Backfill assumes a single existing workspace (the one set up by the install).
-- For fresh installs the UPDATEs are no-ops because all tables are empty.
-- ---------------------------------------------------------------------------

ALTER TABLE users        ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE teams        ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE overrides    ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE dependencies ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS workspace_id TEXT;

-- Backfill from the existing single workspace, if there is exactly one.
DO $$
DECLARE
  ws_count INT;
  default_ws TEXT;
BEGIN
  SELECT COUNT(*) INTO ws_count FROM workspaces;
  IF ws_count = 1 THEN
    SELECT id INTO default_ws FROM workspaces LIMIT 1;
    UPDATE users        SET workspace_id = default_ws WHERE workspace_id IS NULL;
    UPDATE teams        SET workspace_id = default_ws WHERE workspace_id IS NULL;
    UPDATE overrides    SET workspace_id = default_ws WHERE workspace_id IS NULL;
    UPDATE dependencies SET workspace_id = default_ws WHERE workspace_id IS NULL;
    UPDATE team_members SET workspace_id = default_ws WHERE workspace_id IS NULL;
  ELSIF ws_count > 1 THEN
    RAISE NOTICE 'Multiple workspaces found — skipping automatic backfill; populate workspace_id manually.';
  END IF;
END $$;

-- Promote to NOT NULL only if every row has been populated.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users        WHERE workspace_id IS NULL) THEN ALTER TABLE users        ALTER COLUMN workspace_id SET NOT NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM teams        WHERE workspace_id IS NULL) THEN ALTER TABLE teams        ALTER COLUMN workspace_id SET NOT NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM overrides    WHERE workspace_id IS NULL) THEN ALTER TABLE overrides    ALTER COLUMN workspace_id SET NOT NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM dependencies WHERE workspace_id IS NULL) THEN ALTER TABLE dependencies ALTER COLUMN workspace_id SET NOT NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM team_members WHERE workspace_id IS NULL) THEN ALTER TABLE team_members ALTER COLUMN workspace_id SET NOT NULL; END IF;
END $$;

-- Foreign keys (idempotent via constraint lookup).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_workspace_fk')        THEN ALTER TABLE users        ADD CONSTRAINT users_workspace_fk        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_workspace_fk')        THEN ALTER TABLE teams        ADD CONSTRAINT teams_workspace_fk        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'overrides_workspace_fk')    THEN ALTER TABLE overrides    ADD CONSTRAINT overrides_workspace_fk    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dependencies_workspace_fk') THEN ALTER TABLE dependencies ADD CONSTRAINT dependencies_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_members_workspace_fk') THEN ALTER TABLE team_members ADD CONSTRAINT team_members_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE; END IF;
END $$;

CREATE INDEX IF NOT EXISTS users_workspace_idx        ON users(workspace_id);
CREATE INDEX IF NOT EXISTS teams_workspace_idx        ON teams(workspace_id);
CREATE INDEX IF NOT EXISTS overrides_workspace_idx    ON overrides(workspace_id);
CREATE INDEX IF NOT EXISTS dependencies_workspace_idx ON dependencies(workspace_id);
CREATE INDEX IF NOT EXISTS team_members_workspace_idx ON team_members(workspace_id);

