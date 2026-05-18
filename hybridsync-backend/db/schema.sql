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
