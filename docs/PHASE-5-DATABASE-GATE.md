# Phase 5 database gate

The SQL in `services/api/schema/phase5_draft.sql` is a **review-only draft**. Nothing runs or migrates automatically.

Before deployment:
1. Pick and provision a managed PostgreSQL instance and encrypted backup/restore policy.
2. Implement reviewed migrations with forwards/backwards compatibility.
3. Use an app DB role that does not own the tables and has no BYPASSRLS.
4. Authenticate every request server-side and set transaction-local `app.account_id` only from the verified session. Reject requests without session or an owner scope.
5. Build session issuance/rotation/revocation, email verification and recovery, with rate limiting and CSRF measures, **before** exposing sync endpoints.
6. For multi-device writes enforce revision preconditions atomically and return conflicts; preserve tombstones.
7. Store file bytes separately in private object storage, with owner verification and short-lived signed URLs.
8. Test cross-account isolation and malicious tenant IDs, rollback, expiry, concurrent updates, quota, and data import recovery.

The draft's `body` JSON is not a finalized domain contract. Replace with validated schemas before accepting client uploads. No local data may be silently imported.
