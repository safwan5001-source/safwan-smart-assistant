-- Preview-only draft. Apply to disposable CI PostgreSQL only.
-- A stable HMAC identifier from a server-side key must be used for subject_key.
CREATE TABLE login_attempt_buckets (
 subject_key bytea PRIMARY KEY CHECK (octet_length(subject_key) = 32),
 failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
 window_started_at timestamptz NOT NULL DEFAULT now(),
 locked_until timestamptz
);
