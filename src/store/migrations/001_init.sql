CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'stuck', 'done', 'killed')),
  created_at INTEGER NOT NULL,
  max_tokens INTEGER,
  max_steps INTEGER,
  max_usd REAL,
  max_seconds INTEGER
);

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
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
  estimated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  request_id TEXT REFERENCES requests(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX requests_task_ts ON requests (task_id, ts DESC);
CREATE INDEX requests_ts ON requests (ts DESC);
CREATE INDEX events_request ON events (request_id);
CREATE INDEX events_ts ON events (ts DESC);
