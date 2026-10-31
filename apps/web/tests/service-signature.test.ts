import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bodySha256, canonical, newNonce, sign, signedHeaders } from "@/server/service-signature";

const doc = JSON.parse(readFileSync(new URL("../../../shared/service-signature-vectors.json", import.meta.url), "utf8")) as {
  secret: string;
  vectors: { name: string; method: string; target: string; ts: number; nonce: string; body: string; account: string | null; body_sha256: string; canonical: string; signature: string }[];
};

describe("service signature wire contract (same vectors as the Python API)", () => {
  for (const v of doc.vectors) {
    it(`reproduces vector: ${v.name}`, () => {
      expect(bodySha256(v.body)).toBe(v.body_sha256);
      expect(canonical(v.method, v.target, v.ts, v.nonce, v.body_sha256, v.account)).toBe(v.canonical);
      expect(sign(doc.secret, v.method, v.target, v.ts, v.nonce, v.body, v.account)).toBe(v.signature);
    });
  }
});

describe("signedHeaders", () => {
  const secret = "x".repeat(40);
  it("uses seconds, a fresh nonce each time, and omits the account header when absent", () => {
    const a = signedHeaders(secret, { method: "GET", target: "/internal/v1/ping", now: () => 1_767_225_600_999 });
    const b = signedHeaders(secret, { method: "GET", target: "/internal/v1/ping", now: () => 1_767_225_600_999 });
    expect(a["x-svc-ts"]).toBe("1767225600");
    expect(a["x-svc-nonce"]).not.toBe(b["x-svc-nonce"]);
    expect(a["x-svc-nonce"]).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    expect(a["x-svc-sig"]).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toHaveProperty("x-svc-acct");
  });
  it("lower-cases and validates the account id", () => {
    const h = signedHeaders(secret, { method: "GET", target: "/x", account: "11111111-1111-4111-8111-111111111111".toUpperCase(), nonce: "n".repeat(22) });
    expect(h["x-svc-acct"]).toBe("11111111-1111-4111-8111-111111111111");
    for (const bad of ["nope", "00000000-0000-0000-0000-000000000000", "1111"]) {
      expect(() => signedHeaders(secret, { method: "GET", target: "/x", account: bad })).toThrow();
    }
  });
  it("never puts the secret in any header", () => {
    const h = signedHeaders(secret, { method: "POST", target: "/internal/v1/x", body: "{}" });
    expect(JSON.stringify(h)).not.toContain(secret);
  });
  it("generates unique, URL-safe nonces", () => {
    const set = new Set(Array.from({ length: 500 }, newNonce));
    expect(set.size).toBe(500);
  });
});
