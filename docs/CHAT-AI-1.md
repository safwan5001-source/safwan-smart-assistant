# CHAT-AI-1 — Claude (Anthropic) chat

Anthropic Claude is the official primary provider of مساعد صفوان الذكي. This document is the operating manual for the integration that
PR #50 delivers. Nothing here is enabled by default: **Claude is off until every REQUIRED variable below is set.**

## Data flow

```
iPhone (PWA, RTL)  ──owner cookie──▶  Next.js BFF  /api/assistant/*  ──HMAC-signed + acting account──▶  FastAPI /internal/v1/assistant/*  ──server key──▶  api.anthropic.com
                                      (cookie gate, same-origin,                                         (allow-list, budget+rate reservation
                                       first-line limiter, whitelisted replies)                           in PostgreSQL, streaming, persistence)
```

* The Anthropic key exists only in the API service environment. It is never returned, logged, stored in GitHub or sent to the browser.
* There is **no public Anthropic endpoint**: the former `POST /assistant/respond` was removed. The only way to spend is the signed
  `/internal/v1/assistant/*` hop, from the BFF, for an allow-listed account.
* The browser sends `{conversationId, message}` only. The **context is loaded from PostgreSQL by the server**, so a client cannot inject
  history, a system prompt, a model, or another account's conversation.

## Authentication & authorisation (layers)

1. **Owner cookie** (`AI_CHAT_ACCESS_CODE`, HMAC-signed, HttpOnly, SameSite=Strict, Secure in production, 8 h; failures throttled).
2. **Same-origin** check on every state-changing call (CSRF).
3. **HMAC service signature** BFF→API: freshness ±60 s, single-use nonce in PostgreSQL, body + path + acting account bound to the signature.
4. **Acting account**: the BFF sets it from `AI_OWNER_ACCOUNT_ID`; the API refuses accounts not in `AI_ALLOWED_ACCOUNT_IDS`, or disabled in `accounts`.
5. **Row-level security**: every query runs in `owner_transaction`, so a conversation of another account is invisible (404, indistinguishable from "missing").

## Hard cost and request limits

Enforced in PostgreSQL (`ai_usage`, `ai_rate`; migration `0004_ai_chat.sql`), shared by all instances, surviving restarts:

* Before each call the API **reserves** the worst case (whole context + max output tokens, priced from `ANTHROPIC_MODELS`) against the **daily and monthly**
  caps and the **per-minute** request counter, in one atomic transaction. If any limit would be exceeded the request is refused with
  `429` (`budget_daily` / `budget_monthly` / `rate_limited`), **nothing is sent to Anthropic, and the user turn is rolled back**.
* After the answer, the reservation is replaced by the real usage reported by Anthropic. A stopped / failed stream is charged conservatively
  (estimated input + 1 token per streamed character); a provider failure before any output costs nothing.
* A crash between reserve and settle leaves the reservation in place (the budget errs on the safe side; it is never refunded blindly).
* Parallel requests cannot jointly overshoot (row locks); proven by `tests/test_assistant_chat.py::test_parallel_requests_cannot_jointly_exceed_the_cap`.
* The in-memory limiter in the BFF is only a first filter.

Prices are **operator-supplied** (`ANTHROPIC_MODELS`); the code never guesses them. Keep them in sync with Anthropic's pricing page.
Periods are UTC calendar day / month.

## Streaming and Stop

`POST /api/assistant/chat` returns NDJSON (`start`, `delta`…, `done` | `error`). The UI renders deltas as they arrive. **Stop** aborts the browser
request → the BFF aborts the API request → the API closes the upstream Anthropic connection, saves the partial answer (`partial: true`) and settles the spend.
A stream that ends without `done` is shown as an error, never as a complete answer.

## Durable conversations

Stored in the existing `sync_records` table (kinds `conversation` / `message`, tombstone deletes, no DELETE grant). The conversation id is the chat
thread id. Reopening the app keeps the local copy; if iOS evicts local storage, **Settings → Claude → استعادة المحادثات من الخادم** restores them.
Deleting a thread in the UI also tombstones the server copy; **حذف نسخ الخادم** removes all. Attachments are never sent to Claude.

## Settings → Claude (iPhone / RTL)

Connection state (configured / locked / **live probe** = free `GET /v1/models/{id}`), default model, daily & monthly spend meters, request limit,
restore / delete server copies, lock session. It shows no key, no account id and no upstream text.

## Activation checklist (owner)

1. Run migrations (`pnpm db:migrate`; `0004_ai_chat.sql`) and create the owner row in `accounts` through the reviewed bootstrap path.
2. API service: `ASSISTANT_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODELS`, `AI_DAILY_BUDGET_USD`, `AI_MONTHLY_BUDGET_USD`, `AI_ALLOWED_ACCOUNT_IDS`.
3. Web service: `AI_CHAT_ACCESS_CODE`, `AI_OWNER_ACCOUNT_ID`.
4. Open Settings → Claude → unlock → **اختبار الاتصال** must show success (this is the first real call to Anthropic).
5. Send a real message from the iPhone; confirm usage moved in the meter.

## Tests

* `services/api/tests/test_anthropic_provider.py` — client/config, offline.
* `services/api/tests/test_assistant_chat.py` — real PostgreSQL + local fake Anthropic: auth, allow-list, replay, account separation, streaming, context,
  stop/partial, exact spend, daily/monthly caps, parallel cap, rate limit, models, probe.
* `apps/web/tests/assistant*.test.ts` — client stream parser, BFF auth/CSRF/relay/stream, signed streaming hop.
* `scripts/e2e-claude.py` (+ `e2e-claude-ui.cjs`) — real API + Next production build + PostgreSQL + fake Anthropic + iPhone-profile Chromium.

## Not done / residual

* **No real Anthropic call has been made** (no key was available to CI/this work). Step 4 above is the first one.
* The owner-code gate is still a stop-gap until real login (B2). Context for threads that existed before this change starts empty on the server.
* Billing for stopped streams is an upper-bound estimate, not Anthropic's invoice; reconcile with the Console.
* Image/PDF attachments, tool use and browsing from Claude are intentionally not wired (browser work stays in PR #48's gated flow).
