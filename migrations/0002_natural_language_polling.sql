CREATE TABLE IF NOT EXISTS channel_states (
  channel_id TEXT PRIMARY KEY,
  last_message_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processed_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_processed_messages_channel ON processed_messages(channel_id, created_at);

CREATE TABLE IF NOT EXISTS daily_summaries (
  summary_key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
