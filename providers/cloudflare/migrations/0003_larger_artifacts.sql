-- Rebuild the bounded release table because SQLite cannot widen a CHECK constraint.
-- Keep existing immutable releases, channel heads, and audit history intact.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE _direct_ota_releases_backup AS SELECT * FROM releases;
CREATE TABLE _direct_ota_heads_backup AS SELECT * FROM heads;
CREATE TABLE _direct_ota_audit_backup AS SELECT * FROM audit;
CREATE TABLE _direct_ota_event_totals_backup AS SELECT * FROM event_totals;
DROP TABLE event_totals;
DROP TABLE heads;
DROP TABLE audit;
DROP TABLE releases;

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  selector TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  signed TEXT NOT NULL,
  payload TEXT NOT NULL,
  path TEXT,
  sha256 TEXT,
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 0 AND 52428800),
  expires INTEGER NOT NULL,
  promoted INTEGER NOT NULL DEFAULT 0 CHECK (promoted IN (0, 1)),
  CHECK ((path IS NULL AND sha256 IS NULL AND bytes = 0) OR
         (path IS NOT NULL AND sha256 IS NOT NULL AND bytes > 0))
);
INSERT INTO releases SELECT * FROM _direct_ota_releases_backup;
CREATE INDEX releases_promoted_path ON releases(path, promoted);
CREATE INDEX releases_history ON releases(selector, promoted, sequence DESC);

CREATE TABLE heads (
  selector TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  release_id TEXT NOT NULL REFERENCES releases(id)
);
INSERT INTO heads SELECT * FROM _direct_ota_heads_backup;
CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
  release_id TEXT NOT NULL REFERENCES releases(id),
  sequence INTEGER NOT NULL
);
INSERT INTO audit SELECT * FROM _direct_ota_audit_backup;
CREATE INDEX audit_release ON audit(release_id, occurred_at DESC);

CREATE TABLE event_totals (
  release_id TEXT NOT NULL REFERENCES releases(id),
  event TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (release_id, event)
);
INSERT INTO event_totals SELECT * FROM _direct_ota_event_totals_backup;

CREATE TRIGGER releases_capacity BEFORE INSERT ON releases
WHEN (SELECT count(*) FROM releases) >= 10000
BEGIN SELECT RAISE(ABORT, 'RELEASE_CAPACITY'); END;
CREATE TRIGGER heads_capacity BEFORE INSERT ON heads
WHEN (SELECT count(*) FROM heads) >= 256
BEGIN SELECT RAISE(ABORT, 'CHANNEL_CAPACITY'); END;
CREATE TRIGGER head_next BEFORE UPDATE ON heads
WHEN NEW.sequence != OLD.sequence + 1
BEGIN SELECT RAISE(ABORT, 'SEQUENCE_CONFLICT'); END;
CREATE TRIGGER head_insert_audit AFTER INSERT ON heads
BEGIN
  UPDATE releases SET promoted = 1 WHERE id = NEW.release_id;
  INSERT INTO audit(release_id, sequence) VALUES(NEW.release_id, NEW.sequence);
END;
CREATE TRIGGER head_update_audit AFTER UPDATE ON heads
BEGIN
  UPDATE releases SET promoted = 1 WHERE id = NEW.release_id;
  INSERT INTO audit(release_id, sequence) VALUES(NEW.release_id, NEW.sequence);
END;

DROP TABLE _direct_ota_releases_backup;
DROP TABLE _direct_ota_heads_backup;
DROP TABLE _direct_ota_audit_backup;
DROP TABLE _direct_ota_event_totals_backup;
