import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, createVerify } from "node:crypto";
import type { AddressInfo } from "node:net";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ece = require("http_ece") as { decrypt: (buf: Buffer, p: Record<string, unknown>) => Buffer };
import { readNotifyConfig } from "@/server/notify/config";
import { createWebPushSender } from "@/server/notify/push";
import { dispatchTick } from "@/server/notify/dispatch";
import { handleNotify } from "@/server/notify/api";
import { buildRuntime } from "@/server/notify/runtime";
import { createMemoryStore } from "@/server/notify/memory-store";
import { makeSubscription, mkReminder, req, riyadh, testEnv, vapid } from "./notify-helpers";

/**
 * End-to-end through the REAL web-push library: VAPID signing + RFC 8291 aes128gcm encryption, delivered over HTTP to a local
 * mock push service that decrypts with the subscription's private key. This proves the cryptography and headers are valid;
 * it does NOT prove Apple's push service accepts them (needs a real iPhone, see docs).
 */
let server: https.Server; let agent: https.Agent; let port = 0; let status = 201;
const received: { url: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
beforeAll(async () => {
  // web-push only speaks HTTPS, so the mock push service uses a throw-away self-signed certificate
  const dir = mkdtempSync(join(tmpdir(), "mockpush-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  agent = new https.Agent({ rejectUnauthorized: false });
  server = https.createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (rq, rs) => {
    const chunks: Buffer[] = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => { received.push({ url: rq.url ?? "", headers: rq.headers, body: Buffer.concat(chunks) }); rs.statusCode = status; rs.end(); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const b64u = (s: string) => Buffer.from(s, "base64url");
function verifyVapid(authHeader: string) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader)!;
  const [h, p, sig] = m[1].split(".");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(vapid.publicKey).subarray(1, 33).toString("base64url"), y: b64u(vapid.publicKey).subarray(33).toString("base64url") }, format: "jwk" });
  const ok = createVerify("SHA256").update(`${h}.${p}`).verify({ key, dsaEncoding: "ieee-p1363" }, b64u(sig));
  return { ok, claims: JSON.parse(b64u(p).toString()), k: m[2] };
}

describe("real Web Push delivery (VAPID + aes128gcm)", () => {
  it("dispatcher → encrypted push → mock service decrypts exactly the generic payload; VAPID is valid", async () => {
    status = 201; received.length = 0;
    const env = testEnv({ NOTIFY_EXTRA_ENDPOINT_HOSTS: "127.0.0.1" });
    const cfg = readNotifyConfig(env);
    const rt = buildRuntime(cfg, { store: createMemoryStore(), send: createWebPushSender(cfg.push!, { agent }), now: () => riyadh(2026, 11, 3, 9, 0) + 1000 });
    const { sub, ecdh, auth } = makeSubscription(`https://127.0.0.1:${port}/push/abc`);
    const r = await handleNotify(req("POST"), ["devices"], rt);
    const { deviceId, token } = await r.json();
    const hdr = { Authorization: `Bearer ${deviceId}.${token}` };
    void hdr; await rt.store!.setSubscription(deviceId, sub, rt.now()); // API validation (tested elsewhere) rightly refuses loopback hosts
    const reminder = mkReminder({ title: "موعد سري", priority: "high" }, riyadh(2026, 11, 2, 2, 0), "real1");
    await rt.store!.syncReminders(deviceId, [reminder], [], rt.now());
    const rep = await dispatchTick(rt.store!, rt.send!, rt.now());
    expect(rep).toMatchObject({ fired: 1, sent: 1 });
    expect(received).toHaveLength(1);
    const got = received[0];
    expect(got.url).toBe("/push/abc");
    expect(got.headers["content-encoding"]).toBe("aes128gcm");
    expect(got.headers.ttl).toBe("3600");
    expect(got.headers.urgency).toBe("high");
    expect(String(got.headers.topic)).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    const v = verifyVapid(String(got.headers.authorization));
    expect(v.ok).toBe(true);
    expect(v.claims).toMatchObject({ sub: "mailto:ops@example.com", aud: `https://127.0.0.1:${port}` });
    expect(v.k).toBe(vapid.publicKey);
    const plain = JSON.parse(ece.decrypt(got.body, { version: "aes128gcm", privateKey: ecdh, authSecret: auth.toString("base64url") }).toString("utf8"));
    expect(plain).toMatchObject({ v: 1, kind: "reminder", title: "مساعد صفوان", body: "لديك تذكير", generic: true, reminderId: "real1", priority: "high" });
    expect(JSON.stringify(plain)).not.toContain("موعد سري"); // the private title never travels in the default mode
    expect(String(plain.url)).toBe("/reminders?focus=real1");
  });

  it("a push service answering 410 Gone cleans up through the real sender", async () => {
    status = 410; received.length = 0;
    const cfg = readNotifyConfig(testEnv({ NOTIFY_EXTRA_ENDPOINT_HOSTS: "127.0.0.1" }));
    const rt = buildRuntime(cfg, { store: createMemoryStore(), send: createWebPushSender(cfg.push!, { agent }), now: () => riyadh(2026, 11, 3, 9, 0) + 1000 });
    const { sub } = makeSubscription(`https://127.0.0.1:${port}/push/gone`);
    const { deviceId, token } = await (await handleNotify(req("POST"), ["devices"], rt)).json();
    const hdr = { Authorization: `Bearer ${deviceId}.${token}` };
    void hdr; await rt.store!.setSubscription(deviceId, sub, rt.now());
    await rt.store!.syncReminders(deviceId, [mkReminder({}, riyadh(2026, 11, 2, 2, 0), "gone1")], [], rt.now());
    expect(await dispatchTick(rt.store!, rt.send!, rt.now())).toMatchObject({ gone: 1, sent: 0 });
    expect((await rt.store!.getDevice(deviceId))!.subscription).toBeNull();
  });

  it("the sender never leaks endpoint or body into its error", async () => {
    const cfg = readNotifyConfig(testEnv());
    const send = createWebPushSender(cfg.push!, { agent });
    const { sub } = makeSubscription("https://127.0.0.1:1/never"); // refused connection
    const r = await send(sub, "{}", { ttl: 60, urgency: "normal", topic: "t" });
    expect(r.status).toBe(0);
    expect(JSON.stringify(r)).not.toContain("127.0.0.1");
  });
});
