-- Ephemeral PostgreSQL integration gate: session ownership and lifecycle.
-- Synthetic accounts only. No real credentials or production access.
INSERT INTO accounts (id,email_normalized,display_name) VALUES
('33333333-3333-4333-8333-333333333333','session-a@example.invalid','Session A'),
('44444444-4444-4444-8444-444444444444','session-b@example.invalid','Session B');
INSERT INTO sessions (id,account_id,token_hash,expires_at,revoked_at) VALUES
('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333',decode(repeat('aa',32),'hex'),now()+interval '1 hour',NULL),
('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb','44444444-4444-4444-8444-444444444444',decode(repeat('bb',32),'hex'),now()+interval '1 hour',NULL),
('cccccccc-1111-4111-8111-cccccccccccc','33333333-3333-4333-8333-333333333333',decode(repeat('cc',32),'hex'),now()-interval '1 minute',NULL),
('dddddddd-1111-4111-8111-dddddddddddd','33333333-3333-4333-8333-333333333333',decode(repeat('dd',32),'hex'),now()+interval '1 hour',now());
DO $$
BEGIN
 IF (SELECT count(*) FROM sessions WHERE token_hash=decode(repeat('aa',32),'hex') AND expires_at>now() AND revoked_at IS NULL)<>1 THEN
   RAISE EXCEPTION 'FAIL: active session lookup';
 END IF;
 IF (SELECT count(*) FROM sessions WHERE token_hash=decode(repeat('cc',32),'hex') AND expires_at>now() AND revoked_at IS NULL)<>0 THEN
   RAISE EXCEPTION 'FAIL: expired session authorized';
 END IF;
 IF (SELECT count(*) FROM sessions WHERE token_hash=decode(repeat('dd',32),'hex') AND expires_at>now() AND revoked_at IS NULL)<>0 THEN
   RAISE EXCEPTION 'FAIL: revoked session authorized';
 END IF;
 IF (SELECT account_id FROM sessions WHERE token_hash=decode(repeat('bb',32),'hex')) <> '44444444-4444-4444-8444-444444444444'::uuid THEN
   RAISE EXCEPTION 'FAIL: session mapped to wrong owner';
 END IF;
END $$;
UPDATE sessions SET revoked_at=now() WHERE token_hash=decode(repeat('aa',32),'hex') AND revoked_at IS NULL;
DO $$
BEGIN
 IF (SELECT count(*) FROM sessions WHERE token_hash=decode(repeat('aa',32),'hex') AND expires_at>now() AND revoked_at IS NULL)<>0 THEN
   RAISE EXCEPTION 'FAIL: revoked token still active';
 END IF;
 IF (SELECT count(*) FROM sessions WHERE token_hash=decode(repeat('bb',32),'hex') AND expires_at>now() AND revoked_at IS NULL)<>1 THEN
   RAISE EXCEPTION 'FAIL: revoking A affected B';
 END IF;
END $$;
