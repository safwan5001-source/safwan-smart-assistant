-- PREVIEW-ONLY credential schema draft. Never auto-apply to production.
-- Requires reviewed migrations, least-privileged DB roles, rate limiting,
-- account recovery and password reset safeguards before HTTP activation.
CREATE TABLE account_password_credentials (
 account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%' AND length(password_hash) BETWEEN 70 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Restrict credential table to an authenticated application DB role;
-- do not expose password_hash to API responses or sync interfaces.
