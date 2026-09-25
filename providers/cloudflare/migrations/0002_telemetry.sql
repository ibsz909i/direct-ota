CREATE TABLE event_window (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  minute INTEGER NOT NULL,
  events INTEGER NOT NULL CHECK (events >= 0)
);
INSERT INTO event_window VALUES (1, 0, 0);

CREATE TABLE event_totals (
  release_id TEXT NOT NULL REFERENCES releases(id),
  event TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (release_id, event)
);
