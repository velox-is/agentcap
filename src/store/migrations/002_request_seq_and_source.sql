-- Two things the dashboard cursor and the OTel ingest both need.
--
-- 1. `seq`: a monotonic insert counter. Plain rowid is reused after a delete of
--    the highest row, so a `rowid > cursor` feed silently skips rows the moment
--    anything prunes. AUTOINCREMENT keeps the high water mark in sqlite_sequence.
-- 2. `source`: where the row came from (`proxy` or `otel`), so OTel traffic is
--    distinguishable from proxied traffic in the feed.
--
-- The table is recreated because SQLite cannot add an AUTOINCREMENT column in
-- place. The caller has foreign_keys OFF for this, and events.request_id keeps
-- pointing at `requests` because the old table is dropped, not renamed.
CREATE TABLE requests_tmp (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT REFERENCES tasks(id),
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  ts INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  status TEXT NOT NULL,
  http_status INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'proxy'
);

INSERT INTO requests_tmp (id, task_id, agent, model, ts, prompt_tokens, completion_tokens,
                          est_cost, latency_ms, status, http_status, estimated, source)
SELECT id, task_id, agent, model, ts, prompt_tokens, completion_tokens,
       est_cost, latency_ms, status, http_status, estimated, 'proxy'
  FROM requests;

DROP TABLE requests;
ALTER TABLE requests_tmp RENAME TO requests;

CREATE INDEX requests_task_ts ON requests (task_id, ts DESC);
CREATE INDEX requests_ts ON requests (ts DESC);
