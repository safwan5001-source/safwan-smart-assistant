-- Draft only; deployment requires migration review and explicit approval.
CREATE TABLE email_verification_tokens (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 token_hash bytea NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_verification_tokens_account ON email_verification_tokens(account_id,expires_at);
-- Restrict direct table access to the internal authentication service role.
-- Consume and account verification must be in the SAME database transaction.
