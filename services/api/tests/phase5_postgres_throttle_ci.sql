-- Disposable PostgreSQL 16 test, not a production migration.
INSERT INTO login_attempt_buckets (subject_key) VALUES (decode(repeat('ab',32),'hex'));
DO $$
DECLARE n int;
BEGIN
 SELECT failure_count INTO n FROM login_attempt_buckets WHERE subject_key=decode(repeat('ab',32),'hex');
 IF n <> 0 THEN RAISE EXCEPTION 'initial failures must be zero'; END IF;
END $$;
DO $$
DECLARE i int;
BEGIN
 FOR i IN 1..5 LOOP
  INSERT INTO login_attempt_buckets (subject_key,failure_count,window_started_at,locked_until)
  VALUES (decode(repeat('ab',32),'hex'),1,now(),NULL)
  ON CONFLICT (subject_key) DO UPDATE SET
  failure_count=CASE WHEN login_attempt_buckets.window_started_at <= now()-interval '15 minutes' THEN 1 ELSE login_attempt_buckets.failure_count+1 END,
  window_started_at=CASE WHEN login_attempt_buckets.window_started_at <= now()-interval '15 minutes' THEN now() ELSE login_attempt_buckets.window_started_at END,
  locked_until=CASE WHEN login_attempt_buckets.window_started_at <= now()-interval '15 minutes' THEN NULL WHEN login_attempt_buckets.failure_count+1 >= 5 THEN now()+interval '15 minutes' ELSE login_attempt_buckets.locked_until END;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM login_attempt_buckets WHERE subject_key=decode(repeat('ab',32),'hex') AND failure_count=5 AND locked_until > now()) THEN
  RAISE EXCEPTION 'throttle failed to lock after five attempts';
 END IF;
END $$;
