// Navigation policy for the browser worker. Pure functions, no I/O, so every rule is unit-testable.
//
// Two different questions are answered here and must not be confused:
//   * parseTarget  - may the CALLER ask us to open this address?  (strict: https, allow-listed host, no port/credentials/query/fragment)
//   * allowRequest - may the BROWSER fetch this address while rendering?  (every redirect hop, subresource, frame and script)
// The second one is enforced in the browser itself (Playwright route interception, before the request leaves), because a page that is
// allowed to load can still try to reach 169.254.169.254, RFC1918 ranges or a Railway *.internal host through a redirect or <img>.
// Host matching is by exact lower-cased hostname against the allow-list only; IP literals are never allow-listed implicitly.

const MAX_URL_CHARS = 200;
const PATH_RE = /^\/[A-Za-z0-9._~/-]{0,120}$/; // no % escapes, no @, no ? - nothing that can smuggle a second authority or encoding trick

export const normalizeHosts = (list) =>
  [...new Set(list.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];

// ── interactive "lab" scopes ─────────────────────────────────────────────────────────────────────────────────────────────────────
// A scope is `host/prefix/` (e.g. `lab.example.org/browser-lab/`). Only inside a scope may the session CLICK or TYPE; everything else
// the policy allows (the read-only hosts) is look-only. A scope is a host AND a mandatory path prefix, so allow-listing a site's
// test page never allow-lists the rest of that site. The list is empty by default = interactive control is OFF.
const SCOPE_RE = /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9])(\/(?:[A-Za-z0-9._~-]{1,40}\/){1,6})$/;
const INTERNAL_TLD = /\.(internal|local|localhost|localdomain|lan|home|corp|intranet)$/;

/** Parses BROWSER_INTERACTIVE_SCOPES. Throws on anything unusual so a typo can never silently widen (or break) the boundary. */
export function parseScopes(list) {
  const out = [];
  for (const raw of list.map((s) => String(s).trim()).filter(Boolean)) {
    const m = SCOPE_RE.exec(raw);
    if (!m || INTERNAL_TLD.test(m[1]) || raw.includes("..") || raw.length > 120) throw new Error("invalid interactive scope");
    out.push({ host: m[1], prefix: m[2] });
  }
  return out;
}

export function createPolicy(allowHosts, labScopes = []) {
  const hosts = new Set(normalizeHosts(allowHosts));
  const hostAllowed = (hostname) => hosts.has(String(hostname).toLowerCase());
  const scopes = parseScopes(labScopes.map((s) => (typeof s === "string" ? s : `${s.host}${s.prefix}`)));
  const inScope = (u) => u.protocol === "https:" && !u.port && !u.username && !u.password
    && !/[%;\\]|\/\//.test(u.pathname) // no encoded/parameter/backslash/double-slash path tricks inside a scope (a lab server might decode them)
    && scopes.some((s) => u.hostname.toLowerCase() === s.host && u.pathname.startsWith(s.prefix));
  /** May the session click/type on this page? Look-only hosts (example.com) never qualify. */
  const canInteract = (rawUrl) => { try { return inScope(new URL(rawUrl)); } catch { return false; } };

  function parseTarget(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARS) throw new Error("URL not allowed");
    let u;
    try { u = new URL(value); } catch { throw new Error("URL not allowed"); }
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) throw new Error("URL not allowed");
    if (!hostAllowed(u.hostname) || !PATH_RE.test(u.pathname)) throw new Error("URL not allowed");
    return `https://${u.hostname.toLowerCase()}${u.pathname}`; // canonical form: what we validated is exactly what we navigate to
  }

  function allowRequest(rawUrl) {
    try {
      const u = new URL(rawUrl);
      return (u.protocol === "https:" && !u.port && !u.username && !u.password && hostAllowed(u.hostname)) || inScope(u);
    } catch { return false; }
  }

  /** Target of an interactive session or of a `navigate` action: a look-only host page or a page inside a lab scope. Same strictness as parseTarget. */
  function parseSessionTarget(value) {
    try { return parseTarget(value); } catch { /* not a look-only host: try the lab scopes */ }
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARS) throw new Error("URL not allowed");
    let u;
    try { u = new URL(value); } catch { throw new Error("URL not allowed"); }
    if (u.search || u.hash || !inScope(u) || !PATH_RE.test(u.pathname)) throw new Error("URL not allowed");
    return `https://${u.hostname.toLowerCase()}${u.pathname}`;
  }

  /** First page of the first scope: what the chat opens when the owner starts an interactive session without naming a page. */
  const labStartUrl = () => (scopes[0] ? `https://${scopes[0].host}${scopes[0].prefix}index.html` : null);

  return { parseTarget, parseSessionTarget, allowRequest, canInteract, labStartUrl, hostAllowed, hosts: [...hosts], scopes: scopes.map((s) => `${s.host}${s.prefix}`) };
}

/** Page text is untrusted. Remove control characters and bidi overrides (display-spoofing) and cap the length. */
export function cleanText(value, max) {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, max);
}
