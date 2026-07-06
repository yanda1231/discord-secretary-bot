CREATE TABLE IF NOT EXISTS gemini_message_failures (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_failed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_failed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gemini_message_failures_last
  ON gemini_message_failures(last_failed_at);
