CREATE TABLE IF NOT EXISTS model_prices (id text PRIMARY KEY, owner text NOT NULL, data jsonb NOT NULL, created_at bigint NOT NULL, expires_at bigint);
CREATE INDEX IF NOT EXISTS model_prices_owner_idx ON model_prices(owner);
CREATE INDEX IF NOT EXISTS model_prices_expiry_idx ON model_prices(expires_at);
