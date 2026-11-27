/**
 * Safety rules for rendering BASHT's Markdown replies (features/chat/message-body.tsx). Pure helpers, no DOM.
 *
 * - Links: only http(s), mailto and tel. Anything else (javascript:, data:, vbscript:, file:, protocol-relative //host, …) is
 *   not a link at all; its text is still shown.
 * - Images never load from another origin: only a path the app itself serves ("/brand/x.png") is shown as an image; a remote
 *   image becomes a plain link the owner can choose to open.
 */
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Strips the characters browsers ignore inside a URL scheme (controls, whitespace), so "java\tscript:" cannot hide. */
const squash = (url: string) => url.replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "");

/** The URL if it may be a link target, else null. */
export function safeHref(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const u = url.trim();
  if (!u || u.length > 2048) return null;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(squash(u));
  if (!m) return null; // relative / protocol-relative / bare text: not a link in a chat reply
  if (!LINK_PROTOCOLS.has(m[1].toLowerCase() + ":")) return null;
  if (/^https?:$/i.test(m[1] + ":")) {
    try { if (!new URL(squash(u)).hostname) return null; } catch { return null; }
  }
  return u;
}

/** True only for a same-origin path the app serves: "/x/y.png" (not "//host", not "/\\host", no scheme). */
export function isAppPath(url: string | null | undefined): url is string {
  if (typeof url !== "string") return false;
  const u = url.trim();
  return /^\/(?![/\\])/.test(u) && !/[\\\u0000-\u001f]/.test(u) && u.length <= 2048;
}

/** react-markdown's urlTransform: keep a URL only where it can be used safely; everything else becomes "". */
export function markdownUrl(url: string, key: string): string {
  if (key === "src") return isAppPath(url) || safeHref(url)?.match(/^https?:/i) ? url.trim() : "";
  return safeHref(url) ?? "";
}

/** "language-ts" → "ts" (a short, plain label; anything odd is dropped). */
export function codeLanguage(className: unknown): string {
  const m = /(?:^|\s)language-([\w#+.-]{1,24})(?:\s|$)/.exec(typeof className === "string" ? className : "");
  return m ? m[1].toLowerCase() : "";
}


/**
 * True when Markdown would change nothing in this text but its paragraphs: no inline syntax (`*_~[]<>|#\` or an entity), no line
 * that could start a list, rule, heading underline or indented code, and no bare URL / e-mail (GFM links those). Such a reply skips
 * the parser — most short replies — which measurably cuts the cost of opening a conversation on a phone. Errs towards "not plain".
 */
export function isPlainText(text: string): boolean {
  return !/[\\`*_~[\]<>|#&]/.test(text) && !/^[ \t]*([-+=]|\d{1,9}[.)])/m.test(text) && !/^( {4}|\t)/m.test(text) && !/https?:\/\/|www\.|@/i.test(text);
}

/**
 * The direction of a block from its first strong letter (Arabic/Hebrew → rtl, Latin/Greek/Cyrillic → ltr), or undefined to inherit.
 * For containers (list items, quotes, tables): the browser's dir="auto" skips children that carry their own dir, so a container
 * whose text sits in dir="auto" paragraphs would wrongly fall back to LTR.
 */
export function textDirection(text: string): "rtl" | "ltr" | undefined {
  const m = /[֐-ࣿיִ-﷿ﹰ-ﻼ]|[A-Za-zÀ-ʯͰ-ϿЀ-ӿ]/.exec(text);
  return !m ? undefined : /[֐-ࣿיִ-﷿ﹰ-ﻼ]/.test(m[0]) ? "rtl" : "ltr";
}
