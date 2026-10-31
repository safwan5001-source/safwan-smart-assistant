# Phase 5 Preview Login — Security Review Gate

Status: **draft only**. Last green CI is not production authorization.

## Verified in CI
- HTTP login success and invalid-password responses against disposable PostgreSQL 16.
- Persistent session cookie, `/auth/me`, logout/revocation.
- Account-specific PostgreSQL advisory transaction lock and concurrent-attempt test.
- FastAPI, frontend and RLS jobs green.

## Mandatory before activation or main merge
1. **Network-based defenses:** enforce source-IP/device request budgets at trusted reverse proxy or equivalent. Do not trust client-supplied X-Forwarded-For without proxy configuration. Test distributed password spraying and brute-force against many account identifiers.
2. **Account enumeration timing:** a nonexistent account currently avoids Argon2 verification, unlike an existing account with wrong password. Use a constant-work dummy Argon2 hash for absent/ineligible accounts and test comparable response behavior.
3. **Denial-of-service risk:** per-account lockouts permit an attacker to intentionally lock a victim account; adopt progressive throttling and account-safe recovery/notification rather than relying on lockouts alone.
4. **Session hygiene:** evaluate session rotation, concurrent session limits, retention, cookie scope, credential reset revocation, and full recovery + verification workflows.
5. **Database permissions:** apply reviewed reversible migrations with a restricted runtime role; do not use CI's superuser connection for production auth.
6. **HTTP exposure:** Vercel ingress must be explicitly reviewed before exposing auth routes; require TLS and exact PUBLIC_ORIGIN. Do not configure preview auth with production secrets.
7. **Resource isolation:** synchronous Argon2 hashing and psycopg calls inside an async FastAPI handler may block the event loop. Move blocking work to a worker thread or a synchronous endpoint and load-test for exhaustion.
8. **Security review:** cover credential stuffing, timing leaks, CSRF, session fixation, same-site vs cross-site usage, abuse limits, audit logging without secrets and password recovery.

All preview auth routes remain disabled by default and gated by `VERCEL_ENV=preview`. The feature branch is not production-ready.

## Network throttling implementation status
- Preview login now checks both account and ASGI peer buckets within a transaction; failures increment both and success resets only the account bucket.
- **Not production-safe behind an unverified proxy:** `request.client.host` may be the proxy address rather than the actual user IP. Do not enable this feature on Vercel until trusted proxy forwarding and edge-level rate limiting are verified. A shared proxy bucket can deny all users behind it.
- Account and peer lockouts still require abuse tests and recovery rules before public activation.

## Fail-closed ingress verification gate
- `PREVIEW_NETWORK_PEER_VERIFIED=1` is now additionally required for the preview login route; unset means HTTP 503, without attempting password verification or the database.
- This is an **operator attestation**, not a way to authenticate forwarded headers. Do not enable it on Vercel merely because the preview deployment has SSO protection. Validate the ASGI peer provenance and enforce trusted edge limits first.
- A reverse proxy may still collapse many visitors to one IP, causing collective account denial. Resolve this before activation. Production auth remains disabled.

## Shared-network lockout remediation
- Removed network-wide denial decisions and network bucket failure increments from preview login. Only account-specific attempt buckets can return 429.
- Network peer parsing remains a fail-closed ingress validation step, not a rate limiter. This avoids denying a different account solely because it shares a NAT or reverse proxy.
- This change **does not** resolve distributed credential stuffing or per-account denial of service. Verified, trusted edge request limiting and proxy identity remain mandatory before activation; `PREVIEW_NETWORK_PEER_VERIFIED` must remain unset until verified.
