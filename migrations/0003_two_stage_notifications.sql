ALTER TABLE todos ADD COLUMN pre_notify_minutes INTEGER;
ALTER TABLE todos ADD COLUMN pre_notified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE todos ADD COLUMN due_notified INTEGER NOT NULL DEFAULT 0;

ALTER TABLE reminders ADD COLUMN pre_notify_minutes INTEGER;
ALTER TABLE reminders ADD COLUMN pre_notified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN due_notified INTEGER NOT NULL DEFAULT 0;

UPDATE todos SET pre_notified = notified, due_notified = notified;
UPDATE reminders SET pre_notified = notified, due_notified = notified;
