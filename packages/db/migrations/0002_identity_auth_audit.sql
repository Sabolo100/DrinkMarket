-- ============================================================================
-- 0002  Felhasználók, session, auditnapló, rendszerbeállítások
-- Spec 4., 28., 29.1
-- ============================================================================

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  email_normalized  text GENERATED ALWAYS AS (lower(btrim(email))) STORED,
  display_name      text NOT NULL,
  -- scrypt: "scrypt$N$r$p$saltB64$hashB64" — nincs natív függőség
  password_hash     text,
  role              text NOT NULL DEFAULT 'viewer'
                      CHECK (role IN ('viewer','reviewer','catalog_manager','source_manager','admin')),
  status            text NOT NULL DEFAULT 'invited'
                      CHECK (status IN ('invited','active','suspended')),
  invite_token_hash text,
  invite_expires_at timestamptz,
  last_login_at     timestamptz,
  failed_logins     integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (email_normalized);
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,       -- sha256(token), a nyers token soha nem tárolt
  csrf_token    text NOT NULL,
  user_agent    text,
  ip_hash       text,                        -- sha256(ip + secret), nem nyers IP
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only auditnapló (spec 36.3). Törlés/UPDATE trigger tiltja.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_kind    text NOT NULL DEFAULT 'user'
                  CHECK (actor_kind IN ('user','system','worker','scheduler','import','migration')),
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  correlation_id text,
  summary       text,
  before_state  jsonb,
  after_state   jsonb,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx  ON audit_log (actor_user_id, occurred_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, occurred_at DESC);

CREATE OR REPLACE FUNCTION rv_audit_log_immutable()
RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION rv_audit_log_immutable();

-- ---------------------------------------------------------------------------
-- Verziózott rendszerbeállítások (spec 28.)
-- Az aktuális érték mindig a legnagyobb version. A régi verziók megmaradnak.
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key           text NOT NULL,
  version       integer NOT NULL,
  value         jsonb NOT NULL,
  value_type    text NOT NULL DEFAULT 'json'
                  CHECK (value_type IN ('json','number','string','boolean','array')),
  scope         text NOT NULL DEFAULT 'global',
  description   text,
  requires_approval boolean NOT NULL DEFAULT false,
  approved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at   timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  active        boolean NOT NULL DEFAULT true,
  PRIMARY KEY (key, version)
);
CREATE UNIQUE INDEX settings_active_uq ON settings (key) WHERE active;

CREATE TABLE feature_flags (
  key           text PRIMARY KEY,
  enabled       boolean NOT NULL DEFAULT false,
  description   text,
  rollout       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
