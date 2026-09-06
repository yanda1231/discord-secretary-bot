CREATE TABLE IF NOT EXISTS feature_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  requested_by TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL UNIQUE,
  intake_message_id TEXT,
  intake_at TEXT,
  pending_questions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_requests_intake_message
  ON feature_requests(intake_message_id);
