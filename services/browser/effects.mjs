// The EFFECT GATE: what a page's JavaScript can do to the world, decided from facts the page cannot forge.
//
// Why this exists (review F1): whatever a helper reads from a page ("this is a harmless link") is the page's word, and a DOM does not even
// reveal event listeners. So approval cannot be a promise about what a click WILL do; it has to be a limit on what the browser is allowed
// to DO. Every request is judged here from the values the BROWSER assigns (method, resource type, navigation flag, URL), never from anything
// the page reports, and in an interactive session:
//   * a request that can change state (any method other than GET/HEAD) is refused unless an approval opened a one-shot window for exactly
//     that method + URL, and only as a top-level form navigation (never fetch/XHR/beacon);
//   * script-initiated requests (fetch, XHR, EventSource, ping, "other") are refused outright, approved or not;
//   * document navigations are refused unless a user action (navigate, link click, approved form submit) opened a window for that URL,
//     so timers / script redirects cannot move the session;
//   * static subresources (css/js/img/font/media) of the lab load, but not with a query string (the usual shape of a GET "API call");
//   * responses that would download (attachment, or a document type a browser does not render) are refused (see `responseVerdict`).
// A refused request while an action runs is reported as that action's outcome (`effect_blocked`), never swallowed.
const SAFE = new Set(["GET", "HEAD"]);
const STATIC_TYPES = new Set(["stylesheet", "script", "image", "font", "media", "manifest", "texttrack"]);
const RENDERABLE = /^(text\/html|application\/xhtml\+xml|text\/plain)(;|$)/i;

const nl = (v) => String(v).replace(/\r\n?/g, "\n");
const sameEntries = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((e, i) => e[0] === b[i][0] && nl(e[1]) === nl(b[i][1]));
const parts = (raw) => { try { const u = new URL(raw); return { origin: u.origin, path: u.pathname, search: u.search }; } catch { return null; } };

/** Response headers that make the BROWSER itself contact other hosts (hints, rules files, reporting) or keep a document restorable without a request: dropped from every document of an interactive session. */
const DROPPED_HEADERS = /^(content-length|content-encoding|transfer-encoding|link|speculation-rules|reporting-endpoints|report-to|nel|refresh|cache-control|pragma|expires)$/i;
export function sanitizeDocumentHeaders(headers) {
  return [...(headers ?? []).filter((h) => !DROPPED_HEADERS.test(h.name)), { name: "Cache-Control", value: "no-store" }]; // no-store: no back/forward-cache replay that skips every hook
}

export function createEffectGate({ onViolation = () => {} } = {}) {
  let windowOpen = true;                 // a session starts inside its first navigation
  let auth = [];                         // [{ method, url, query: boolean, uses }]
  const violations = [];
  const note = (reason) => { violations.push(reason); onViolation(reason); };

  function matches(a, method, url) {
    const want = parts(a.url), got = parts(url);
    if (!want || !got || a.method !== method) return false;
    if (!(want.origin === got.origin && want.path === got.path && (!a.query || want.search === got.search))) return false;
    // a form submission (GET or POST): the data actually sent must be exactly the data the owner was shown (GET: its query; POST: checked on the body in decide)
    if (a.entries && method === "GET") { try { return sameEntries([...new URL(url).searchParams], a.entries); } catch { return false; } }
    return true;
  }

  return {
    /** Open the window of ONE user action. `allow` lists what it may do: [{method:"GET"|"POST", url, query?}] (query:true = the query must match too). */
    begin(allow = []) { windowOpen = true; auth = allow.map((a) => ({ ...a, method: String(a.method).toUpperCase(), uses: 0 })); violations.length = 0; },
    /** Close it; returns the reasons of everything refused while it was open. */
    end() { windowOpen = false; auth = []; return violations.splice(0); },
    pendingViolations: () => violations.length,
    isOpen: () => windowOpen,

    /** Judge one outgoing request. `type` is Playwright's resourceType(); `navigation` its isNavigationRequest(). */
    decide({ method, type, url, navigation, postData = null }) {
      const m = String(method).toUpperCase();
      if (!SAFE.has(m)) {
        // an approved POST must also carry exactly the fields the owner was shown (urlencoded only): the page may not edit them after approval
        const a = auth.find((x) => x.method === m && x.uses < 1 && matches(x, m, url)
          && (!x.entries || (postData !== null && sameEntries([...new URLSearchParams(postData)], x.entries))));
        if (windowOpen && a && navigation && type === "document") { a.uses++; return { allow: true }; }
        note("unauthorized_effect"); return { allow: false, reason: "unauthorized_effect" };
      }
      if (type === "document") {
        const a = auth.find((x) => x.method === "GET" && x.uses < 4 && matches(x, "GET", url));
        if (windowOpen && a) { a.uses++; return { allow: true }; }
        note("unexpected_navigation"); return { allow: false, reason: "unexpected_navigation" };
      }
      if (STATIC_TYPES.has(type)) {
        if (parts(url)?.search) { note("subresource_query"); return { allow: false, reason: "subresource_query" }; }
        return { allow: true };
      }
      note("script_request"); return { allow: false, reason: "script_request" };   // xhr, fetch, eventsource, websocket, ping, other...
    },

    /** Judge a RESPONSE (or a redirect) before the browser acts on it. `request.method` is the method of the request that produced it. */
    responseVerdict({ method, type, status, headers = {}, url = "" }) {
      const m = String(method).toUpperCase();
      if (status >= 300 && status < 400 && !SAFE.has(m)) { note("redirected_effect"); return { allow: false, reason: "redirected_effect" }; } // 307/308 would replay the POST elsewhere
      // a document redirect inside an action window may only land on the URL that action authorised (path + the approved data), or on a query-free page of the same origin
      if (status >= 300 && status < 400 && String(type) === "document" && SAFE.has(m) && headers.location) {
        const next = (() => { try { return new URL(headers.location, url); } catch { return null; } })();
        const ok = !!next && windowOpen && (auth.some((a) => a.method === "GET" && matches(a, "GET", next.href)) || (!next.search && next.origin === new URL(url, "https://x").origin));
        if (!ok) { note("unexpected_redirect"); return { allow: false, reason: "unexpected_redirect" }; }
      }
      // redirect hops never pass through the request judge: a query-free static URL must not bounce to one WITH a query (the shape of a GET "API call")
      if (status >= 300 && status < 400 && STATIC_TYPES.has(String(type)) && headers.location) {
        const next = (() => { try { return new URL(headers.location, url); } catch { return null; } })();
        if (!next || next.search) { note("subresource_query"); return { allow: false, reason: "subresource_query" }; }
      }
      const disposition = String(headers["content-disposition"] ?? "").toLowerCase();
      if (/^\s*attachment/.test(disposition)) { note("download_blocked"); return { allow: false, reason: "download_blocked" }; }
      // a document with NO Content-Type is not "renderable by default": the browser would sniff it (and may download it)
      if (type === "document" && status < 300 && status >= 200 && status !== 204 && status !== 205 && !RENDERABLE.test(String(headers["content-type"] ?? ""))) { note("download_blocked"); return { allow: false, reason: "download_blocked" }; }
      return { allow: true };
    },
  };
}
