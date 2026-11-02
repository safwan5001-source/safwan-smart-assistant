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

export function createPolicy(allowHosts) {
  const hosts = new Set(normalizeHosts(allowHosts));
  const hostAllowed = (hostname) => hosts.has(String(hostname).toLowerCase());

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
      return u.protocol === "https:" && !u.port && !u.username && !u.password && hostAllowed(u.hostname);
    } catch { return false; }
  }

  return { parseTarget, allowRequest, hostAllowed, hosts: [...hosts] };
}

/** Page text is untrusted. Remove control characters and bidi overrides (display-spoofing) and cap the length. */
export function cleanText(value, max) {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, max);
}
