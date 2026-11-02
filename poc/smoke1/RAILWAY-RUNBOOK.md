# Browserbase Smoke-1 on Railway (isolated runner)

This is an **isolated test runner**, not a new production browser API. It is separate from `safwan-api` (Python). Never expose Browserbase secrets to `@safwan/web`.

## Preparation

1. Create a dedicated Railway service `safwan-browser-smoke` in the existing **Safwan Smart Assistant** project, attached to the same GitHub repository.
2. Set the Dockerfile path to `poc/smoke1/Dockerfile.railway` and keep the build context at the repository root.
3. Configure environment variables **on this service only**:
   - `BROWSERBASE_API_KEY` — Railway reference to `safwan-api`'s existing key (or set it as a sealed variable).
   - `BROWSERBASE_PROJECT_ID` — Railway reference to `safwan-api`'s existing project ID.
   - `SMOKE1_APPROVED=yes` — explicit approval for real Browserbase access.
4. Disable automatic deployment for the test service if possible; use a one-off run only. Its default CMD does **not** access Browserbase.

## Run once

Temporarily set the service start command to:

```sh
node smoke1.mjs --cloud --no-ttl-test
```

Read the deployment logs for PASS/FAIL and ensure the Browserbase session is released. The program has a bounded wall-clock limit and releases in `finally`. After the test **restore the inert default start command** and disable automatic restarts/deploys for this one-off service.

Do not paste API keys, Browserbase live/debug URLs, connection WebSocket URLs, or full raw logs in tickets or chat. Mask sensitive URLs.

## Limitations

- The existing Smoke-1 harness tests its fixture page rather than arbitrary external websites.
- Browserbase credentials present in Railway do not by themselves make the user-facing assistant capable of browsing. That requires a separately reviewed, authenticated tool backend with allowlisting, rate limits, permission checks, and audit logging.
- No real cloud session is started simply by merging this Dockerfile.
