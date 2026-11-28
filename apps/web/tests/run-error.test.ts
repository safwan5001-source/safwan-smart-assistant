import { describe, expect, it } from "vitest";
import { GENERIC_RUN_ERROR_TEXT, providerLimitNoticeText, RATE_LIMIT_IMAGE_TEXT, RATE_LIMIT_TEXT, runErrorKind, runErrorRetryable, runErrorText } from "@/lib/run-error";

const NOTICE = "OpenAI Codex image generation failed (HTTP 429) usage_limit_reached";
describe("run error mapping (generation limit, R12)", () => {
  it("the structured errorCode wins; without image context the message is generic", () => {
    expect(runErrorKind({ errorCode: "rate_limited", text: "" })).toBe("rate_limited");
    expect(runErrorKind({ errorCode: "Rate_Limited" })).toBe("rate_limited");
    expect(runErrorText({ errorCode: "rate_limited" })).toBe("بلغ حد استخدام الاشتراك؛ حاول لاحقًا");
    expect(RATE_LIMIT_TEXT).not.toContain("الصور");
  });
  it("«لتوليد الصور» only when the notice came from an image generation", () => {
    expect(runErrorText({ errorCode: "rate_limited", text: NOTICE })).toBe("بلغ حد استخدام الاشتراك لتوليد الصور؛ حاول لاحقًا");
    expect(runErrorText({ text: NOTICE })).toBe(RATE_LIMIT_IMAGE_TEXT);
    expect(runErrorText({ text: "HTTP 429 usage_limit_reached" })).toBe(RATE_LIMIT_TEXT);
  });
  it("the legacy provider text is recognised only in its anchored form (it starts the message)", () => {
    expect(runErrorKind({ text: NOTICE })).toBe("rate_limited");
    expect(runErrorKind({ text: "error: usage_limit_reached" })).toBe("rate_limited");
    expect(runErrorKind({ text: "usage_limit_reached" })).toBe("rate_limited");
    expect(runErrorKind({ text: "HTTP 429 Too Many Requests" })).toBe("rate_limited");
    expect(runErrorKind({ text: "(HTTP 429) usage_limit_reached" })).toBe("rate_limited");
  });
  it("a text that merely MENTIONS 429 is not a rate limit (no false positives on ordinary failures)", () => {
    expect(runErrorKind({ text: "request failed with HTTP 429" })).toBe("generic");
    expect(runErrorKind({ text: "The tool returned a page that explains HTTP 429 errors." })).toBe("generic");
    expect(runErrorKind({ text: "HTTP 4290" })).toBe("generic");
    expect(runErrorKind({ text: "x".repeat(700) + " usage_limit_reached" })).toBe("generic"); // a long answer is never a notice
  });
  it("anything else (or nothing) is the generic message; unknown codes are not acted on", () => {
    expect(runErrorKind({ errorCode: "timeout", text: "boom" })).toBe("generic");
    expect(runErrorKind({ errorCode: 429 as unknown as string })).toBe("generic");
    expect(runErrorKind(null)).toBe("generic");
    expect(runErrorText({ text: "something failed" })).toBe(GENERIC_RUN_ERROR_TEXT);
  });
  it("a rate limit is not offered a resend; other failures are", () => {
    expect(runErrorRetryable({ errorCode: "rate_limited" })).toBe(false);
    expect(runErrorRetryable({ text: NOTICE })).toBe(false);
    expect(runErrorRetryable({ text: "request failed with HTTP 429" })).toBe(true);
    expect(runErrorRetryable({ text: "boom" })).toBe(true);
  });
  it("only the provider's own quota notice is rewritten in the history (an answer that merely mentions 429 is left alone)", () => {
    expect(providerLimitNoticeText(NOTICE)).toBe(RATE_LIMIT_IMAGE_TEXT);
    expect(providerLimitNoticeText("usage_limit_reached")).toBe(RATE_LIMIT_TEXT);
    expect(providerLimitNoticeText("رمز الخطأ 429 يعني كثرة الطلبات.")).toBeNull();
    expect(providerLimitNoticeText("HTTP 429 is what you get when ...")).toBeNull(); // anchored, but not the provider's quota token
    expect(providerLimitNoticeText("usage_limit_reached ".repeat(100))).toBeNull();
    expect(providerLimitNoticeText(undefined)).toBeNull();
  });
});
