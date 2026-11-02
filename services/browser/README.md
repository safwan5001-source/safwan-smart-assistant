# Safwan Browser — permanent isolated service (V1)

Private HTTP worker on Railway. **The service is permanent, Browserbase sessions are ephemeral.** Initial allowlist is `example.com` only. V1 can navigate and return title; **no general browsing, arbitrary scripts, or user credential handling**.

## Railway setup after PR review and merge
- Create separate `safwan-browser` service in **Safwan Smart Assistant**; use repository root build context and Dockerfile `services/browser/Dockerfile`.
- Set `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` as server-side Railway variable references to the existing `safwan-api` variables.
- Set `BROWSER_SERVICE_TOKEN` to a **new random 32+ character secret** in the browser service and the calling API, never in web frontend.
- Leave `BROWSER_ALLOWED_HOSTS=example.com` for the initial test.
- Use private Railway networking; **do not create a public domain for this service**.
- Endpoints: `GET /health` (non-sensitive status) and authenticated `POST /v1/navigate` with JSON `{"url":"https://example.com"}`.
- Only one session at a time, maximum 120 s Browserbase session lifetime, explicit release in `finally`. Check deployment logs and report no connection URLs, keys, or page content secrets.
- The API integration to call this service is deliberately **not yet wired**. Before enabling user-facing browsing: add authenticated API policy, per-action confirmation, destination/network guardrails, audit events, timeouts, quotas and tests.

## Security boundary
Allowlisted domains only. No private-network navigation permitted through arbitrary input; redirects to disallowed hosts are rejected after navigation, so before using this beyond the fixed trusted test host, implement request interception to prevent off-allowlist redirects and subresources. Do not broaden `BROWSER_ALLOWED_HOSTS` without a security review.
