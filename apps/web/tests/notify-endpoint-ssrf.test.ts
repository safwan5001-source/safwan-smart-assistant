import { parse as legacyParse } from "node:url";
import { describe, expect, it } from "vitest";
import { isAllowedEndpoint, type EndpointPolicy } from "@/server/notify/validate";

/**
 * Independent security review IR-W1: `isAllowedEndpoint` approves a push endpoint with the WHATWG `URL` parser, but the `web-push`
 * library connects using the legacy `url.parse(endpoint).hostname`. Where the two disagree about the host, the allow-list
 * checked one host and the server connected to another (SSRF to any host:443). The invariant below is what protects against
 * that, whatever characters an attacker tries.
 */
const policy: EndpointPolicy = { extraHosts: [], production: true };

describe("push endpoint allow-list vs the parser web-push really uses", () => {
  it("still accepts the real push services", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bH",
      "https://web.push.apple.com/QGZ_x-9Yz",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAD",
      "https://fcm.googleapis.com:443/fcm/send/abc",
    ]) expect(isAllowedEndpoint(ok, policy), ok).toBe(true);
  });

  it("rejects endpoints whose host differs between the two parsers (the confirmed bypasses)", () => {
    for (const bad of [
      "https://localhost;.push.apple.com/fcm/send/abc",
      "https://internal.example%e3%80%82a.push.apple.com/x",
      "https://internal.example。a.push.apple.com/x",
      "https://internal.example%2ea.push.apple.com/x",
      "https://a%00.push.apple.com/x",
      "https://a\t.push.apple.com/x",
      "https://a\n.push.apple.com/x",
      "https://evil.test\\@fcm.googleapis.com/x",
      "https://fcm.googleapis.com\\.evil.test/x",
      "https://evil.test#@fcm.googleapis.com/x",
      "https://evil.test?@fcm.googleapis.com/x",
      "https://localhost@fcm.googleapis.com/x",
      "https://FCM.googleapis.com.evil.test/x",
    ]) expect(isAllowedEndpoint(bad, policy), JSON.stringify(bad)).toBe(false);
  });

  it("never approves an endpoint for which url.parse and WHATWG URL name different hosts (fuzzed)", () => {
    const specials = [";", "%", "%2e", "%e3%80%82", "%00", "%0a", "\t", "\n", "\r", " ", "\\", "@", "#", "?", ":", "。", "．", "․", "­", "[", "]", "\u0000", "\u0085", " "];
    const hosts = ["x.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com", "a.notify.windows.com", "web.push.apple.com"];
    let approved = 0;
    for (const host of hosts) {
      for (const sp of specials) {
        for (let i = 0; i <= host.length; i++) {
          for (const raw of [
            `https://${host.slice(0, i)}${sp}${host.slice(i)}/p/q`,
            `https://${sp}${host}/p`,
            `https://${host}${sp}/p`,
            `https://l${sp}${host}/p`,
            `https://${host}:443${sp}/p`,
            `https://${host.slice(0, i)}${sp}${sp}${host.slice(i)}/p`,
          ]) {
            if (!isAllowedEndpoint(raw, policy)) continue;
            approved++;
            const whatwg = new URL(raw).hostname.toLowerCase();
            const legacy = (legacyParse(raw).hostname ?? "").toLowerCase();
            expect(legacy, JSON.stringify(raw)).toBe(whatwg);
          }
        }
      }
    }
    expect(approved).toBeGreaterThan(0); // the canonical cases inside the fuzz set are still approved: the loop is not vacuous
  });
});
