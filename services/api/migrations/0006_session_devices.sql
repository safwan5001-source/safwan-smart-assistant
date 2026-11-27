-- 0006_session_devices (login gate): a short, owner-visible name for the device a session was opened on ("آيفون · Safari"),
-- so the owner can tell sessions apart in «الدخول والأمان» and end one. Additive only: one nullable column, no grant change
-- (INSERT is table-level; the runtime's column-level UPDATE stays revoked_at + last_seen_at), no policy or function change.
ALTER TABLE sessions ADD COLUMN device_label text CHECK (device_label IS NULL OR char_length(device_label) BETWEEN 1 AND 80);
