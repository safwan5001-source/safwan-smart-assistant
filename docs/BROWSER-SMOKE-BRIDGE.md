# Private Browserbase smoke test

`POST /internal/browser/smoke` is a narrow diagnostic endpoint, *not* the assistant's normal browsing interface.

Requirements on `safwan-api` in Railway:
- `BROWSER_SERVICE_TOKEN` reference to `safwan-browser.BROWSER_SERVICE_TOKEN`.
- `BROWSER_SERVICE_URL=http://safwan-browser.railway.internal:8080`.
- No client/UI access to the token; do not log request authorization.
- The endpoint only accepts `https://example.com`, has no arbitrary host parameter, and never returns page content or secrets.
- Keep `safwan-browser` private (no public domain).

After deployment, perform a **single authorized call** to the diagnostic endpoint using a secure in-environment tool that does not print the shared token. Confirm title `Example Domain` and review Browserbase session release. A successful deploy/healthcheck alone does not validate a live Browserbase connection.

This diagnostic is not safe to expose as an end-user feature. Production user identity, authorization, rate limits, audit, and robust browser policy must precede a general browse tool.
