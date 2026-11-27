import "server-only";
/**
 * /api/basht/{send-media,media,new,search} — BASHT B1 (chat basics) + B2 (media in/out). Called by handleBashtChat AFTER its owner
 * gate, same-origin check and limiter, so every rule of that door applies here too.
 *
 *   send-media  POST {message, images:[{mime, data}]}  photos ride on the SAME BASHT turn (the app's own session only)
 *   media       GET  ?key=&msg=&ref=                   one image/file of one message of a readable conversation (bytes)
 *   new         POST                                   «محادثة جديدة» (the engine keeps every earlier message)
 *   search      GET  ?q=                               BASHT's own search over the owner's readable conversations
 *
 * The browser never names a session to write to, a path or a file: refs are opaque ids the engine handed out.
 */
import { readConfig } from "./backend";
import { signedHeaders } from "./service-signature";
import type { Deps } from "./basht-chat";

export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_TOTAL = 14 * 1024 * 1024;
export const MAX_SEND_MEDIA_BODY = 19 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);
/** What a media answer may be served as (the API applies the same list). */
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif", "application/pdf", "text/plain",
  "text/markdown", "text/csv", "application/json", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "video/mp4"]);
const KEY = /^agent:[a-z0-9_-]{1,64}:\S{1,200}$/i;
const MSG = /^[A-Za-z0-9_-]{6,100}$/;
const REF = /^[0-9a-f]{32}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The engine's own photo refusals, passed to the browser as they are (a fixed list; never upstream text). */
export const MEDIA_CODES = new Set(["too_many_images", "image_too_large", "images_too_large", "unsupported_image"]);

type Relay = (apiPath: string, method: "GET" | "POST", body?: unknown, pick?: (j: Record<string, unknown>) => unknown, timeoutMs?: number) => Promise<Response>;
export type ExtrasCtx = { relay: Relay; deps: Deps & { fetchImpl?: typeof fetch } };

const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" } as const;
const err = (code: string, status: number) => new Response(JSON.stringify({ error: code }), { status, headers: HEADERS });

/** Reads a JSON body of at most `max` bytes (cut off while streaming, never buffered whole). */
async function readJsonCapped(req: Request, max: number): Promise<Record<string, unknown> | undefined> {
  if ((req.headers.get("content-type") ?? "").split(";")[0].trim() !== "application/json") return undefined;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return undefined;
  const reader = req.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return undefined; }
    chunks.push(value);
  }
  try { const v = JSON.parse(Buffer.concat(chunks).toString("utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : undefined; } catch { return undefined; }
}

export const decodedSize = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

/** The photos of one turn, validated (count, type, base64, sizes). Returns the clean list or an error code. */
export function checkImages(raw: unknown): { images: { mime: string; data: string }[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "bad_request" };
  if (raw.length > MAX_IMAGES) return { error: "too_many_images" };
  let total = 0;
  const images: { mime: string; data: string }[] = [];
  for (const it of raw) {
    const mime = typeof (it as { mime?: unknown })?.mime === "string" ? (it as { mime: string }).mime : "";
    const data = typeof (it as { data?: unknown })?.data === "string" ? (it as { data: string }).data : "";
    if (!IMAGE_TYPES.has(mime)) return { error: "unsupported_image" };
    if (!data || data.length % 4 !== 0 || !B64.test(data)) return { error: "bad_request" };
    const size = decodedSize(data);
    if (size > MAX_IMAGE_BYTES) return { error: "image_too_large" };
    total += size;
    if (total > MAX_IMAGES_TOTAL) return { error: "images_too_large" };
    images.push({ mime, data });
  }
  return { images };
}

/** One signed API call whose 200 answer is BYTES (a media file), capped; never follows redirects. */
async function fetchMedia(deps: ExtrasCtx["deps"], body: { key: string; msg: string; ref: string }): Promise<Response> {
  const cfg = readConfig(deps.env);
  if (!cfg) return err("unavailable", 503);
  const path = "/internal/v1/basht/media";
  const url = new URL(cfg.base.href.replace(/\/+$/, "") + path);
  const json = JSON.stringify(body);
  const headers = { accept: "*/*", "content-type": "application/json", ...signedHeaders(cfg.secret, { method: "POST", target: url.pathname + url.search, body: json, now: deps.now }) };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 50_000);
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, { method: "POST", headers, body: json, redirect: "manual", cache: "no-store", signal: ctl.signal });
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => {});
      const m: Record<number, [number, string]> = { 400: [400, "bad_request"], 404: [404, "not_found"], 413: [413, "too_large"], 415: [415, "unsupported"], 422: [400, "bad_request"], 429: [429, "rate_limited"] };
      const e = m[res.status]; return e ? err(e[1], e[0]) : err("unavailable", 503);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!MEDIA_TYPES.has(type)) { await res.body.cancel().catch(() => {}); return err("unsupported", 415); }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) { await res.body.cancel().catch(() => {}); return err("too_large", 413); }
    const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MEDIA_BYTES) { await reader.cancel().catch(() => {}); return err("too_large", 413); }
      chunks.push(value);
    }
    const disp = /filename\*=UTF-8''([^;\s]+)/i.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "file";
    return new Response(Buffer.concat(chunks), { status: 200, headers: {
      "Content-Type": type, "Content-Length": String(total),
      // <img> ignores the disposition; a direct open downloads. The bytes can never run as a page of this origin.
      "Content-Disposition": `attachment; filename*=UTF-8''${disp.replace(/[^A-Za-z0-9%._~-]/g, "_").slice(0, 400)}`,
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, max-age=600",
      "Cross-Origin-Resource-Policy": "same-origin",
    } });
  } catch { return err("unavailable", 503); }
  finally { clearTimeout(timer); }
}

/** Returns a Response for a B1/B2 route, or null when `route` is not one of them. */
export async function handleBashtExtras(req: Request, route: string, ctx: ExtrasCtx): Promise<Response | null> {
  const { relay } = ctx;
  if (req.method === "POST" && route === "send-media") {
    const data = await readJsonCapped(req, MAX_SEND_MEDIA_BODY);
    if (!data) return err("bad_request", 400);
    const message = typeof data.message === "string" ? data.message : "";
    if (message.length > 8000) return err("bad_request", 400);
    const checked = checkImages(data.images);
    if ("error" in checked) return err(checked.error, 400);
    return relay("/internal/v1/basht/send-media", "POST", { message: message.trim(), images: checked.images }, (j) => ({ runId: j.run_id }), 70_000);
  }
  if (req.method === "GET" && route === "media") {
    const u = new URL(req.url);
    const key = u.searchParams.get("key") ?? ""; const msg = u.searchParams.get("msg") ?? ""; const ref = u.searchParams.get("ref") ?? "";
    if (!KEY.test(key) || !MSG.test(msg) || !REF.test(ref)) return err("bad_request", 400);
    return fetchMedia(ctx.deps, { key, msg, ref });
  }
  if (req.method === "POST" && route === "new") {
    return relay("/internal/v1/basht/new", "POST", {}, (j) => ({ at: typeof j.at === "number" ? j.at : null, earlier: j.earlier === true }), 70_000);
  }
  if (req.method === "GET" && route === "search") {
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
    if (!q || q.length > 200) return err("bad_request", 400);
    return relay("/internal/v1/basht/search", "POST", { q }, (j) => ({ results: Array.isArray(j.results) ? j.results : [] }), 35_000);
  }
  return null;
}
