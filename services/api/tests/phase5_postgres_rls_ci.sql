-- PostgreSQL 16 integration gate for the Phase 5 PREVIEW schema.
-- CI-only synthetic accounts. No production database or credentials.
CREATE ROLE safwan_ci_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO safwan_ci_runtime;
GRANT SELECT, UPDATE ON sync_records TO safwan_ci_runtime;
INSERT INTO accounts (id,email_normalized,display_name) VALUES
('11111111-1111-4111-8111-111111111111','ci-a@example.invalid','CI A'),
('22222222-2222-4222-8222-222222222222','ci-b@example.invalid','CI B');
INSERT INTO sync_records (account_id,kind,id,revision,body) VALUES
('11111111-1111-4111-8111-111111111111','task','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'{"name":"a"}'),
('22222222-2222-4222-8222-222222222222','task','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'{"name":"b"}');
SET ROLE safwan_ci_runtime;
-- Missing owner context cannot access records.
DO $$
BEGIN
 IF (SELECT count(*) FROM sync_records) <> 0 THEN
   RAISE EXCEPTION 'FAIL: anonymous read returned records';
 END IF;
END $$;
BEGIN;
SELECT set_config('app.account_id','11111111-1111-4111-8111-111111111111',true);
DO $$
BEGIN
 IF (SELECT count(*) FROM sync_records) <> 1 THEN
   RAISE EXCEPTION 'FAIL: owner A can read wrong number of records';
 END IF;
 IF EXISTS (SELECT 1 FROM sync_records WHERE account_id='22222222-2222-4222-8222-222222222222') THEN
   RAISE EXCEPTION 'FAIL: cross-owner read';
 END IF;
 IF (SELECT count(*) FROM (UPDATE sync_records SET body='{"wrong":true}' WHERE account_id='22222222-2222-4222-8222-222222222222' RETURNING id) AS illegal_write) <> 0 THEN
   RAISE EXCEPTION 'FAIL: cross-owner write';
 END IF;
 IF (SELECT count(*) FROM (UPDATE sync_records SET body='{"name":"new"}',revision=revision+1 WHERE account_id='11111111-1111-4111-8111-111111111111' AND revision=999 RETURNING id) AS stale_update) <> 0 THEN
   RAISE EXCEPTION 'FAIL: stale revision accepted';
 END IF;
 IF (SELECT count(*) FROM (UPDATE sync_records SET body='{"name":"new"}',revision=revision+1 WHERE account_id='11111111-1111-4111-8111-111111111111' AND revision=1 RETURNING id) AS correct_update) <> 1 THEN
   RAISE EXCEPTION 'FAIL: valid revision rejected';
 END IF;
END $$;
COMMIT;
-- Transaction-local account scope must not survive COMMIT.
DO $$
BEGIN
 IF (SELECT count(*) FROM sync_records) <> 0 THEN
   RAISE EXCEPTION 'FAIL: owner scope leaked between transactions';
 END IF;
END $$;
BEGIN;
SELECT set_config('app.account_id','22222222-2222-4222-8222-222222222222',true);
DO $$
BEGIN
 IF (SELECT count(*) FROM sync_records) <> 1 THEN
   RAISE EXCEPTION 'FAIL: owner B isolation';
 END IF;
END $$;
ROLLBACK;
RESET ROLE;
