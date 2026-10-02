-- Cognia public status service: subscriptions, notification outbox and
-- operator alerts (owner E).
--
-- Privacy: an address is stored only as an HMAC lookup index plus AES-GCM
-- ciphertext, each recording the key ID it was made with so keys can rotate.
-- Tokens are stored as SHA-256 hashes only. IP rate buckets are keyed by an
-- HMAC of (day, IP) and expire; no raw IP is ever written.
--
-- Times are integer milliseconds since the Unix epoch (UTC).

-- ---------------------------------------------------------------------------
-- Subscribers.
-- ---------------------------------------------------------------------------
CREATE TABLE subscribers (
  id TEXT PRIMARY KEY,
  email_hmac TEXT NOT NULL UNIQUE,
  email_hmac_key_id TEXT NOT NULL,
  -- base64url(iv || ciphertext); NULL once a suppressed row is purged down
  -- to its suppression HMAC.
  email_ciphertext TEXT,
  email_key_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'unsubscribed', 'suppressed')),
  locale TEXT NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  component_ids_json TEXT NOT NULL,
  -- Bumped by unsubscribe / suppression; outbox rows and manage tokens are
  -- bound to the value they were created under.
  consent_version INTEGER NOT NULL,
  -- The consent wording version the subscriber agreed to.
  consent_terms_version INTEGER NOT NULL,
  preference_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  -- Start of the current double opt-in; pending rows expire 24 h after it.
  pending_since INTEGER,
  confirmed_at INTEGER,
  updated_at INTEGER NOT NULL,
  last_confirmation_sent_at INTEGER,
  suppressed_reason TEXT,
  purge_after INTEGER,
  -- Random per write; dependent statements of the same batch check it.
  write_token TEXT
);
CREATE INDEX subscribers_by_state ON subscribers (state, id);
CREATE INDEX subscribers_by_purge ON subscribers (purge_after);

CREATE TABLE subscriber_tokens (
  -- sha256 hex of the raw token.
  token_hash TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('confirm', 'manage')),
  consent_version INTEGER NOT NULL,
  preference_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX subscriber_tokens_by_subscriber ON subscriber_tokens (subscriber_id);
CREATE INDEX subscriber_tokens_by_expiry ON subscriber_tokens (expires_at);

-- Fixed-window abuse counters (IP per 10 min, global confirmations per hour).
CREATE TABLE rate_buckets (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_buckets_by_expiry ON rate_buckets (expires_at);

-- ---------------------------------------------------------------------------
-- Notification events and the email outbox.
-- ---------------------------------------------------------------------------
-- One row per public event, keyed by a stable ID (`incident-update:<id>`,
-- `maintenance:<id>:<kind>:<revision>`, `confirm:<subscriber>:<n>`), so a
-- replayed reconciliation cannot create a second event.
CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Fan-out progress: subscribers are visited in id order after the cursor.
  fanout_cursor TEXT,
  fanout_done INTEGER NOT NULL DEFAULT 0 CHECK (fanout_done IN (0, 1))
);
CREATE INDEX notification_events_pending_fanout ON notification_events (fanout_done, created_at);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  -- notification: needs a confirmed subscriber; confirmation: a pending one;
  -- welcome / manage_link: a confirmed one.
  purpose TEXT NOT NULL CHECK (purpose IN ('notification', 'confirmation', 'welcome', 'manage_link')),
  consent_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'leased', 'provider_accepted', 'retryable_failure', 'terminal_failure', 'uncertain', 'suppressed', 'cancelled')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  -- The delivery lease that claimed the row (owner + fence); a leased row
  -- whose owner is not the current lease holder belongs to a dead runner.
  lease_owner TEXT,
  lease_fence INTEGER,
  -- Set by the guarded statement immediately before the provider call; a
  -- leased row with this set and no recorded outcome is `uncertain`.
  attempt_started_at INTEGER,
  provider_message_id TEXT,
  -- Immutable rendered payload; nulled by retention once finished.
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  payload_digest TEXT NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Random per operator write (delivery retry); guards its audit row.
  write_token TEXT,
  UNIQUE (subscriber_id, event_id, channel, consent_version)
);
CREATE INDEX outbox_due ON outbox (state, next_attempt_at);
CREATE INDEX outbox_by_subscriber_state ON outbox (subscriber_id, state);
CREATE INDEX outbox_by_updated ON outbox (updated_at);

-- ---------------------------------------------------------------------------
-- Operator alert de-duplication (fixed configured destination).
-- ---------------------------------------------------------------------------
CREATE TABLE operator_alerts (
  key TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  last_sent_at INTEGER NOT NULL
);
