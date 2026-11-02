-- Shared SAML correlation/replay cache and opaque browser sessions.
-- Apply only through an approved migration process. No roles, live grants,
-- identity-provider configuration, credentials or mailbox permissions created.
-- Dedicated authentication runtime role must be approved separately; ordinary
-- web/ingestion roles must not receive direct access to these tables.
BEGIN;
CREATE SCHEMA bb_auth;
REVOKE ALL ON SCHEMA bb_auth FROM PUBLIC;

CREATE TABLE bb_auth.entries (
  namespace text NOT NULL CHECK (namespace ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$'),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9:_-]{0,100}:[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 16384),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  PRIMARY KEY (namespace, key)
);
CREATE INDEX auth_entries_expiry ON bb_auth.entries(namespace, expires_at);

CREATE TABLE bb_auth.sessions (
  namespace text NOT NULL CHECK (namespace ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$'),
  key text NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
  entra_tenant_id uuid NOT NULL,
  entra_object_id uuid NOT NULL,
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  last_seen_at timestamptz NOT NULL CHECK (isfinite(last_seen_at)),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  reauth_at timestamptz NOT NULL CHECK (isfinite(reauth_at)),
  PRIMARY KEY (namespace, key),
  CHECK (created_at <= last_seen_at),
  CHECK (last_seen_at < reauth_at AND reauth_at <= expires_at)
);
CREATE INDEX auth_sessions_identity ON bb_auth.sessions(namespace, entra_tenant_id, entra_object_id);
CREATE INDEX auth_sessions_expiry ON bb_auth.sessions(namespace, reauth_at);
REVOKE ALL ON ALL TABLES IN SCHEMA bb_auth FROM PUBLIC;
COMMIT;
