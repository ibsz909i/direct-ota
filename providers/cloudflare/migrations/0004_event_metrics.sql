-- Bounded, aggregate-only operational hints. No installation or account identifiers.
ALTER TABLE event_totals ADD COLUMN measured INTEGER NOT NULL DEFAULT 0 CHECK (measured >= 0);
ALTER TABLE event_totals ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0);
ALTER TABLE event_totals ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0);
ALTER TABLE event_totals ADD COLUMN retries INTEGER NOT NULL DEFAULT 0 CHECK (retries >= 0);
ALTER TABLE event_totals ADD COLUMN max_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (max_duration_ms >= 0);
ALTER TABLE event_totals ADD COLUMN wifi INTEGER NOT NULL DEFAULT 0 CHECK (wifi >= 0);
ALTER TABLE event_totals ADD COLUMN cellular INTEGER NOT NULL DEFAULT 0 CHECK (cellular >= 0);
ALTER TABLE event_totals ADD COLUMN unknown_connection INTEGER NOT NULL DEFAULT 0 CHECK (unknown_connection >= 0);
