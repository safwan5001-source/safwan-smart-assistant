import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Service-to-service request signing (BFF -> API). Mirrors services/api/app/service_auth.py; the wire contract is
 * pinned by shared/service-signature-vectors.json, verified by both test suites.
 */
export const CONTEXT = "safwan-svc-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const bodySha256 = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");

export function canonical(method: string, target: string, ts: number, nonce: string, bodyHash: string, account?: string | null): string {
  return [CONTEXT, method.toUpperCase(), target, String(ts), nonce, bodyHash, account ?? "-"].join("\n");
}

export function sign(secret: string, method: string, target: string, ts: number, nonce: string, body: string | Uint8Array, account?: string | null): string {
  return createHmac("sha256", secret).update(canonical(method, target, ts, nonce, bodySha256(body), account), "utf8").digest("hex");
}

/** 24 URL-safe chars (144 bits). A fresh nonce for every request; the API rejects reuse. */
export const newNonce = (): string => randomBytes(18).toString("base64url");

export type SignInput = { method: string; target: string; body?: string; account?: string | null; now?: () => number; nonce?: string };

export function signedHeaders(secret: string, input: SignInput): Record<string, string> {
  const account = input.account ? input.account.toLowerCase() : null;
  if (account !== null && !UUID.test(account)) throw new Error("invalid account id");
  const ts = Math.floor((input.now ?? Date.now)() / 1000);
  const nonce = input.nonce ?? newNonce();
  const headers: Record<string, string> = {
    "x-svc-ts": String(ts),
    "x-svc-nonce": nonce,
    "x-svc-sig": sign(secret, input.method, input.target, ts, nonce, input.body ?? "", account),
  };
  if (account) headers["x-svc-acct"] = account;
  return headers;
}
