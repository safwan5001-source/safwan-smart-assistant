import { callBackend } from "@/server/backend";
import { COOKIE_NAME, COOKIE_PATH, codeMatches, issueCookieValue, readCookie, readGate, setCookieHeader, verifyCookieValue } from "@/server/assistant-chat-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" };
const json = (value: unknown, status = 200, extra: Record<string,string> = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, ...extra } });
const sameOrigin = (req: Request) => {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  const site = req.headers.get("sec-fetch-site");
  if (!origin || !host || (site && site !== "same-origin")) return false;
  try { return new URL(origin).host === host; } catch { return false; }
};
const attempts = new Map<string,{ count:number; reset:number }>();
const replyAttempts = new Map<string,{ count:number; reset:number }>();
const canTry = (now:number) => {
  const key = "owner-unlock";
  const v = attempts.get(key);
  if (!v || v.reset < now) { attempts.set(key,{count:1,reset:now+60000}); return true; }
  if (v.count >= 5) return false;
  v.count++;
  return true;
};
type Context = { params: Promise<{ path: string[] }> };
async function handler(req: Request, ctx: Context) {
  const { path } = await ctx.params;
  const route = path.join("/");
  const gate = readGate(process.env);
  const now = Date.now();
  if (req.method === "GET" && route === "status") return json({ enabled: !!gate, authenticated: !!gate && verifyCookieValue(gate, readCookie(req), now) });
  if (!gate) return json({ error: "disabled" }, 503);
  if (req.method === "POST" && route === "session") {
    if (!sameOrigin(req)) return json({error:"forbidden"},403);
    if (!canTry(now)) return json({error:"rate_limited"},429);
    let data: unknown;
    try { data = await req.json(); } catch { return json({error:"bad_request"},400); }
    const code = (data && typeof data === "object" && "code" in data) ? (data as {code:unknown}).code : undefined;
    if (!codeMatches(gate, code)) return json({error:"unauthorized"},401);
    attempts.delete("owner-unlock");
    return json({authenticated:true},200,{"Set-Cookie":setCookieHeader(issueCookieValue(gate, now), process.env.NODE_ENV==="production")});
  }
  if (req.method === "DELETE" && route === "session") {
    if (!sameOrigin(req)) return json({error:"forbidden"},403);
    return json({authenticated:false},200,{"Set-Cookie":`${COOKIE_NAME}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${process.env.NODE_ENV === "production" ? "; Secure" : ""}`});
  }
  if (!verifyCookieValue(gate, readCookie(req), now)) return json({error:"unauthorized"},401);
  if (req.method !== "POST" || route !== "respond") return json({error:"not_found"},404);
  if (!sameOrigin(req)) return json({error:"forbidden"},403);
  const usage = replyAttempts.get("owner");
  if (usage && usage.reset > now && usage.count >= 10) return json({error:"rate_limited"},429);
  if (!usage || usage.reset <= now) replyAttempts.set("owner",{count:1,reset:now+60000}); else usage.count++;
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({error:"bad_request"},400);
  if (Number(req.headers.get("content-length") ?? 0) > 25000) return json({error:"too_large"},413);
  let data: unknown;
  try {
    const reader = req.body?.getReader();
    if (!reader) return json({error:"bad_request"},400);
    const pieces: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 25000) { await reader.cancel(); return json({error:"too_large"},413); }
      pieces.push(value);
    }
    data = JSON.parse(Buffer.concat(pieces).toString("utf8"));
  } catch { return json({error:"bad_request"},400); }
  const messages = data && typeof data === "object" && "messages" in data ? (data as {messages:unknown}).messages : undefined;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 40 || messages.some(m => !m || typeof m !== "object" || !["user","assistant"].includes(m.role) || typeof m.content !== "string" || !m.content.trim() || m.content.length > 8000) || messages[messages.length - 1].role !== "user") return json({error:"bad_request"},400);
  const result = await callBackend({path:"/internal/v1/assistant/respond",method:"POST",body:{messages},timeoutMs:55000,maxBytes:65536});
  if (result.kind !== "ok" || result.status !== 200) return json({error:"unavailable"},503);
  const reply = result.json as {content?:unknown};
  if (typeof reply?.content !== "string" || reply.content.length > 60000 || !reply.content) return json({error:"unavailable"},502);
  return json({content:reply.content});
}
export { handler as GET, handler as POST, handler as DELETE };
