CREATE TABLE IF NOT EXISTS usage_days (id text PRIMARY KEY, owner text NOT NULL, data jsonb NOT NULL, created_at bigint NOT NULL, expires_at bigint);
CREATE INDEX IF NOT EXISTS usage_days_owner_idx ON usage_days(owner);
CREATE INDEX IF NOT EXISTS usage_days_expiry_idx ON usage_days(expires_at);
CREATE INDEX IF NOT EXISTS usage_days_dimensions_idx ON usage_days (owner, (data->>'date'), (data->>'deviceId'), (data->>'agent'), (data->>'project'));
