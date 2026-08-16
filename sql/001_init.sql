CREATE TABLE IF NOT EXISTS fatsecret_accounts (
  id UUID PRIMARY KEY,
  label VARCHAR(80) NOT NULL,
  oauth_token_encrypted TEXT NOT NULL,
  oauth_secret_encrypted TEXT NOT NULL,
  profile JSONB,
  diary_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oauth_requests (
  oauth_token TEXT PRIMARY KEY,
  oauth_secret_encrypted TEXT NOT NULL,
  account_label VARCHAR(80) NOT NULL,
  session_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS oauth_requests_created_at_idx
  ON oauth_requests (created_at);
