-- Daily cost per provider and service. API pulls replace their own rows for the days they cover.
CREATE TABLE IF NOT EXISTS costs (
  provider   TEXT NOT NULL,           -- anthropic | openai | aws | azure | gcp
  day        TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
  service    TEXT NOT NULL,           -- model or cloud service name
  amount_usd REAL NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',  -- currency the provider reported in
  source     TEXT NOT NULL DEFAULT 'api',  -- api | webhook
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, day, service)
);
CREATE INDEX IF NOT EXISTS costs_day ON costs(day);

-- Usage logged by hand from the dashboard (any API without a billing API).
CREATE TABLE IF NOT EXISTS entries (
  id         TEXT PRIMARY KEY,
  day        TEXT NOT NULL,
  category   TEXT NOT NULL,           -- ai | cloud | other
  provider   TEXT NOT NULL,
  service    TEXT NOT NULL,
  usage      TEXT,                    -- human-readable usage line
  amount_usd REAL NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_day ON entries(day);

-- Month-to-date readings from Google Cloud budget notifications.
CREATE TABLE IF NOT EXISTS gcp_snapshots (
  budget     TEXT NOT NULL,
  day        TEXT NOT NULL,
  cost_mtd   REAL NOT NULL,
  currency   TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (budget, day)
);

-- Every webhook received, for the activity feed and debugging.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  payload     TEXT,
  received_at INTEGER NOT NULL
);

-- One row per threshold alert sent, so each level fires once a month.
CREATE TABLE IF NOT EXISTS alerts (
  month   TEXT NOT NULL,
  scope   TEXT NOT NULL,              -- 'total' or a provider id
  level   INTEGER NOT NULL,           -- percent of budget
  sent_at INTEGER NOT NULL,
  detail  TEXT,
  PRIMARY KEY (month, scope, level)
);

-- Last sync result per provider.
CREATE TABLE IF NOT EXISTS runs (
  provider TEXT PRIMARY KEY,
  ran_at   INTEGER NOT NULL,
  ok       INTEGER NOT NULL,
  message  TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Request counts from API gateways, per day / gateway / API / consumer.
CREATE TABLE IF NOT EXISTS gateway_usage (
  day         TEXT NOT NULL,
  gateway     TEXT NOT NULL,          -- slug, e.g. kong, aws-api-gateway
  api         TEXT NOT NULL,          -- API, route or service name (or a path pattern)
  consumer    TEXT NOT NULL DEFAULT '',
  requests    INTEGER NOT NULL DEFAULT 0,
  err4xx      INTEGER NOT NULL DEFAULT 0,
  err5xx      INTEGER NOT NULL DEFAULT 0,
  latency_sum REAL NOT NULL DEFAULT 0,  -- ms, summed over requests that reported latency
  latency_n   INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  last_at     INTEGER NOT NULL,
  PRIMARY KEY (day, gateway, api, consumer)
);
CREATE INDEX IF NOT EXISTS gateway_usage_gw ON gateway_usage(gateway, day);

-- Keys entered in the dashboard's Connections panel, AES-GCM encrypted.
-- A Cloudflare secret with the same name takes priority.
CREATE TABLE IF NOT EXISTS credentials (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
