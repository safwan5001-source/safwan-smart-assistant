import "server-only";
/**
 * The client address used as the key of every BFF rate limiter (one helper, so no door trusts a different header).
 *
 * Railway's edge sets `X-Real-IP` to the client's remote address (docs: Networking → Specs & Limits → Technical specifications);
 * Vercel's edge sets it too. `X-Forwarded-For` is NOT trusted by its first entry, which any client can write: only its LAST entry is
 * used as a fallback (the one appended by the proxy closest to us). Without either header (local dev, tests) every caller shares
 * "unknown", which only ever throttles more, never less.
 */
const IP = /^[0-9A-Fa-f:.]{2,45}$/;

export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real && IP.test(real)) return real;
  const last = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  if (last && IP.test(last)) return last;
  return "unknown";
}
