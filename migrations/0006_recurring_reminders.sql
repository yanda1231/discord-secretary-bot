ALTER TABLE reminders ADD COLUMN recurrence_rule TEXT;
ALTER TABLE reminders ADD COLUMN recurrence_label TEXT;
ALTER TABLE reminders ADD COLUMN recurrence_timezone TEXT;
ALTER TABLE reminders ADD COLUMN last_fired_at TEXT;
ALTER TABLE reminders ADD COLUMN recurrence_active INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_reminders_recurrence
  ON reminders(recurrence_active, recurrence_rule, remind_at);
