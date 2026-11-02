import { describe, expect, it } from "vitest";
import { BROWSER_TEST_URL, STEP_IDS, isAllowedBrowserUrl, isTaskId, parseBrowseCommand, parseTaskView } from "@/lib/browser-task";

const ID = "11111111-1111-4111-8111-111111111111";
const view = (over: Record<string, unknown> = {}) => ({
  id: ID, status: "running", url: "https://example.com/", sessionReleased: false, steps: STEP_IDS.map((id) => ({ id, status: "pending" })), ...over,
});

describe("allowed target", () => {
  it.each(["https://example.com", "https://example.com/", "https://example.com/a/b-c_d.html"])("accepts %s", (u) => expect(isAllowedBrowserUrl(u)).toBe(true));
  it.each([
    "http://example.com/", "https://example.com:8443/", "https://user:pw@example.com/", "https://example.com@evil.test/", "https://example.com.evil.test/",
    "https://example.com/?a=1", "https://example.com/#x", "https://example.com/a/../b", "https://example.com/%2e", "https://EXAMPLE.com/",
    "https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/", "https://localhost/", "file:///etc/passwd", "javascript:alert(1)", "", " https://example.com/",
    "https://example.com/\n", "https://example.com/" + "a".repeat(250),
  ])("rejects %j", (u) => expect(isAllowedBrowserUrl(u)).toBe(false));
  it.each([undefined, null, 5, {}, ["https://example.com/"]])("rejects non-string %j", (v) => expect(isAllowedBrowserUrl(v)).toBe(false));
  it("task ids are v4 uuids in lower case", () => {
    expect(isTaskId(ID)).toBe(true);
    for (const bad of ["x", ID.toUpperCase().replace(/[0-9]/g, "A"), ID + "x", "../" + ID, "11111111-1111-1111-1111-111111111111", 5, null]) expect(isTaskId(bad)).toBe(false);
  });
});

describe("parseTaskView", () => {
  it("rebuilds a view and drops everything unknown", () => {
    const v = parseTaskView({ ...view(), connectUrl: "wss://secret", sessionId: "s", signingKey: "k", steps: view().steps.map((s) => ({ ...s, extra: 1 })) })!;
    expect(Object.keys(v).sort()).toEqual(["id", "sessionReleased", "status", "steps", "url"]);
    expect(JSON.stringify(v)).not.toMatch(/secret|signingKey|sessionId|extra/);
  });
  it("sanitises untrusted result text", () => {
    const v = parseTaskView(view({ status: "succeeded", result: { title: "T‮" + "x".repeat(400), url: "https://example.com/", excerpt: "a\u0000b‏c" + "y".repeat(9000), hasScreenshot: true } }))!;
    expect(v.result!.title.length).toBe(200);
    expect(v.result!.excerpt.length).toBe(4000);
    expect(v.result!.excerpt.startsWith("abc")).toBe(true);
    expect(/[‮‏\u0000]/.test(v.result!.title + v.result!.excerpt)).toBe(false);
  });
  it("collapses unknown error codes", () => expect(parseTaskView(view({ status: "failed", error: "ECONNREFUSED http://x" }))!.error).toBe("browser_execution_failed"));
  it.each([
    null, "x", [], {}, view({ id: "nope" }), view({ status: "weird" }), view({ url: "https://evil.test/" }), view({ steps: [] }),
    view({ steps: [...view().steps].reverse() }), view({ steps: STEP_IDS.map((id) => ({ id, status: "???" })) }),
    view({ result: { url: "https://evil.test/", title: "", excerpt: "", hasScreenshot: false } }), view({ result: "x" }),
  ])("rejects malformed %#", (bad) => expect(parseTaskView(bad)).toBeNull());
});

describe("/متصفح quick command", () => {
  it("is not a browse command unless it starts with the command", () => {
    for (const t of ["متصفح", "افتح المتصفح", "/مهمة متصفح", "hello /browse"]) expect(parseBrowseCommand(t)).toBeNull();
  });
  it("offers the test site by default and for allowed addresses (nothing runs yet)", () => {
    expect(parseBrowseCommand("/متصفح")).toEqual({ kind: "offer", url: BROWSER_TEST_URL });
    expect(parseBrowseCommand("/browse")).toEqual({ kind: "offer", url: BROWSER_TEST_URL });
    expect(parseBrowseCommand("/متصفح example.com")).toEqual({ kind: "offer", url: "https://example.com" });
    expect(parseBrowseCommand("/browse https://example.com/page")).toEqual({ kind: "offer", url: "https://example.com/page" });
  });
  it.each(["https://evil.test", "http://example.com", "https://169.254.169.254/", "localhost", "https://example.com:8080/", "https://example.com/?x=1", "file:///etc/passwd", "a b"])(
    "blocks %j with an explanation", (arg) => {
      const r = parseBrowseCommand(`/متصفح ${arg}`);
      expect(r?.kind).toBe("blocked");
    });
  it.each(["انقر على زر الدفع", "سجل دخول إلى الحساب", "click the buy button", "login to example.com", "اكتب كلمة المرور", "submit the form", "delete everything", "ادفع الفاتورة"])(
    "refuses action requests (%s): read-only, no approval flow exists", (arg) => {
      const r = parseBrowseCommand(`/browse ${arg}`);
      expect(r?.kind).toBe("blocked");
      expect((r as { reason: string }).reason).toMatch(/قراءة فقط/);
    });
});
