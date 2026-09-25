PRAGMA foreign_keys = ON;

CREATE TABLE publisher_window (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  minute INTEGER NOT NULL,
  commands INTEGER NOT NULL CHECK (commands >= 0)
);
INSERT INTO publisher_window VALUES (1, 0, 0);

CREATE TABLE nonces (
  nonce TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);
CREATE INDEX nonces_expires ON nonces(expires);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  selector TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  signed TEXT NOT NULL,
  payload TEXT NOT NULL,
  path TEXT,
  sha256 TEXT,
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 0 AND 5242880),
  expires INTEGER NOT NULL,
  promoted INTEGER NOT NULL DEFAULT 0 CHECK (promoted IN (0, 1)),
  CHECK ((path IS NULL AND sha256 IS NULL AND bytes = 0) OR
         (path IS NOT NULL AND sha256 IS NOT NULL AND bytes > 0))
);
CREATE INDEX releases_promoted_path ON releases(path, promoted);

CREATE TABLE heads (
  selector TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  release_id TEXT NOT NULL REFERENCES releases(id)
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
  release_id TEXT NOT NULL REFERENCES releases(id),
  sequence INTEGER NOT NULL
);
CREATE INDEX audit_release ON audit(release_id, occurred_at DESC);

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
