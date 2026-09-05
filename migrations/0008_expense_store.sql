ALTER TABLE expenses ADD COLUMN store TEXT;
ALTER TABLE pending_actions ADD COLUMN message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_actions_message_id
  ON pending_actions(message_id);
