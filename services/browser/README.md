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
- Job API (used by the chat, see `docs/CHAT-BROWSER.md`): `POST /v1/jobs`, `GET /v1/jobs/:id`, `GET /v1/jobs/:id/screenshot`, `POST /v1/jobs/:id/cancel` (real cancellation: closes Chromium, releases the Browserbase session). `/v1/navigate` is kept for the owner smoke/read bridges and shares the same single slot.
- The chat route in the API is **off unless `BROWSER_CHAT_ENABLED=1`** on `safwan-api`; this service needs no new variables.
- Tests: `npm test` (unit + HTTP + a real-Chromium end-to-end that proves off-list redirects/subresources never reach the network).

## Security boundary
Allowlisted domains only. No private-network navigation permitted through arbitrary input; off-allow-list redirects are blocked BEFORE they are followed (CDP Fetch at the response stage — Playwright's `route` alone does not see redirect hops) and subresources/frames/popups are aborted before leaving the browser. Do not broaden `BROWSER_ALLOWED_HOSTS` without a security review.
