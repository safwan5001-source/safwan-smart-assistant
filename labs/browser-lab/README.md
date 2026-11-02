# Browser lab (CHAT-BROWSER-2 test pages)

Static, inert pages for exercising the interactive browser session. **Deploy this folder as its OWN static project on its OWN registrable
domain** (not a sub-path or subdomain of the assistant's app or API): the cloud browser and anything on these pages must share no cookies,
storage, origin or privileges with the assistant. The app refuses a lab scope that shares a site with the app or the API.

Rules for this folder (enforced by `services/browser/test/lab-page.test.mjs`):
- no network of any kind from the pages (no fetch/XHR/WebSocket/beacon/images/frames/forms to anywhere), no third-party scripts, no cookies;
- every control name stays clear of the hard-denial words (pay/delete/login/account/password/…);
- `vercel.json` carries the security headers (CSP `default-src 'none'`, no framing, no referrer, COOP/CORP same-origin).

Scope string for the services (set by the owner, never from a session): `BROWSER_INTERACTIVE_SCOPES=<lab-host>/browser-lab/`
— serve these files under the path prefix `/browser-lab/` of that host (e.g. a `public/browser-lab/` directory in the lab project).
