/**
 * What of a BASHT reply may be SPOKEN (and what a streaming bubble may show). The engine strips its own markers too; this is the
 * client-side defence so BASHT never reads out "MEDIA: /tmp/…", a file path, a URL or markdown punctuation.
 *
 *  - `stripMediaMarkers(text)`: drops `MEDIA:` lines/markers and a partial marker still arriving at the end of a stream.
 *    Markdown is kept (for display while streaming).
 *  - `speakableText(text)`: the above, plus code blocks, links/images (their label stays), bare URLs, absolute paths, HTML tags,
 *    headings/list/quote/table/emphasis markup — leaving plain sentences for the TTS.
 */

/** A whole `MEDIA:` line (any case, optional bullet/quote/backticks before it). */
const MEDIA_LINE = /^[ \t>*\-`]*MEDIA\s*:.*$/gimu;
/** An inline `MEDIA: <path-or-url>` marker inside a sentence. */
const MEDIA_INLINE = /`?MEDIA\s*:\s*(?:"[^"\n]*"|'[^'\n]*'|<[^>\n]*>|\S+)`?/giu;
/** A marker still being streamed at the very end: "M", "ME", … "MEDIA:", "MEDIA: /pa" (only at a line start or after a space). */
const PARTIAL_TAIL = /(^|[\s>`])(?:M|ME|MED|MEDI|MEDIA|MEDIA\s*:[^\n]*)$/u;

export function stripMediaMarkers(text: string, { streaming = false }: { streaming?: boolean } = {}): string {
  if (!text) return "";
  let s = text.replace(/\r\n?/g, "\n").replace(MEDIA_LINE, "").replace(MEDIA_INLINE, "");
  if (streaming) s = s.replace(PARTIAL_TAIL, "$1");
  return s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gmu, "").trim();
}

const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s<>()]+/giu;
const WWW_RE = /\bwww\.[^\s<>()]+/giu;
/** /abs/path/like.this, ~/x/y, C:\\dir\\file — two or more segments, so "و/أو" or "1/2" survive. */
const PATH_RE = /(?:^|(?<=[\s(«"'`]))(?:~|[A-Za-z]:)?(?:[\\/][\w.\-@+]+){2,}[\\/]?/gu;

export function speakableText(text: string, opts: { streaming?: boolean } = {}): string {
  let s = stripMediaMarkers(text, opts);
  if (!s) return "";
  s = s
    .replace(/```[\s\S]*?(```|$)/gu, " ")              // fenced code (also an unterminated one while streaming)
    .replace(/<\/?[a-z][^>\n]*>/giu, " ")                // HTML tags
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")           // images → their alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")            // links → their label
    .replace(/<((?:https?|mailto):[^>]+)>/giu, " ")       // autolinks
    .replace(URL_RE, " ").replace(WWW_RE, " ")
    .replace(PATH_RE, " ")
    .replace(/`([^`\n]*)`/gu, "$1")                      // inline code → its text
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gmu, "")           // headings
    .replace(/^[ \t]*>[ \t]?/gmu, "")                     // quotes
    .replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gmu, "")    // list bullets / numbers
    .replace(/^[ \t]*\|?[ \t:]*-{3,}[ \t:|-]*$/gmu, "")   // table separator rows
    .replace(/[ \t]*\|[ \t]*/gu, "، ")                    // table cells → a pause
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gmu, "")        // horizontal rules
    .replace(/(\*\*|__|~~)(.+?)\1/gu, "$2")               // bold / strike
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/gu, "$1$2") // italics
    .replace(/[*_~`#]+/gu, " ");                          // stray markup
  return s
    .split("\n").map((l) => l.replace(/^[\s،,;]+|[\s،,;]+$/gu, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([.،,!?؟:])/gu, "$1"))
    .filter(Boolean).join("\n").replace(/(?:،\s*){2,}/gu, "، ").trim();
}
