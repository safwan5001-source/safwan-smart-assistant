# Phase 5 — Secure account and cross-device synchronization

Status: design foundation only. No production auth or sync is enabled.

## Existing state (verified)
- Web: Next.js 15 with locally stored chats and tasks; attachments in browser IndexedDB.
- API: minimal FastAPI task stub without persistence or authentication.
- Local user data must not be overwritten or silently uploaded.

## Architecture decisions
1. One private account first. Server-owned identity; do not trust a client-supplied user ID.
2. A persistent relational database for accounts, conversation metadata, messages, tasks, and attachment references. Each row is scoped to an authenticated owner.
3. Binary files in private object storage with presigned, short-lived operations and ownership checks. Never expose a public bucket or raw object key as authorization.
4. Auth uses a supported managed identity provider or reviewed server-side sessions; HttpOnly Secure SameSite cookies, CSRF protection where required, rate limiting, verified email and recovery. No credentials in localStorage.
5. All APIs enforce account authorization; request validation, size/extension safeguards, file content handling and abuse limits. No AI parsing at this stage.
6. Safe migration is explicit opt-in, previewable and repeatable: retain the local originals, assign stable local IDs, and use idempotent imports to avoid duplicates. Allow export and rollback. Do not delete local data automatically.
7. Sync tracks revisions/updated_at and tombstones; resolve concurrent updates explicitly. Test multiple devices, offline edits, retries, deletes and account switch.
8. Encrypt transport (TLS); protect storage secrets and production credentials with environment separation, least privilege and rotation. Document retention and account deletion before launch.
9. Data exported or downloaded only following the authenticated owner's request; never leak private files via caches.

## Incremental delivery
- P5-A: schema, threat model, configuration, API contracts and auth provider decision (no live credentials).
- P5-B: authentication (registration/login/logout/refresh/recovery), isolation tests, backend database, staging deployment.
- P5-C: private attachment storage and signed access with limits, auditing and tests.
- P5-D: opt-in local-to-account import, progress/duplicate control, recovery and multi-device sync.
- P5-E: Safari/iPhone and desktop acceptance, migration rehearsal, production release only after approval.

## Acceptance gates
- Unauthorized requests and cross-account IDOR attempts denied.
- Closing/reopening Safari does not unexpectedly log out; logout revokes the session.
- An existing local conversation/task/file remains intact throughout import failure.
- Same account shows correct synced data across two devices; offline collisions are controlled.
- Storage quota, retry, deletion, partial upload, duplicate import and failure cases tested.
- CI passes; PR reviewed and merged; staging then production validated separately.

No AI integration until separately authorized.
