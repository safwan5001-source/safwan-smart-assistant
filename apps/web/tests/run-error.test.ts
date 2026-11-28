import { describe, expect, it } from "vitest";
import { GENERIC_RUN_ERROR_TEXT, isProviderLimitNotice, RATE_LIMIT_TEXT, runErrorKind, runErrorRetryable, runErrorText } from "@/lib/run-error";

describe("run error mapping (generation limit, R12)", () => {
  it("the structured errorCode wins", () => {
    expect(runErrorKind({ errorCode: "rate_limited", text: "" })).toBe("rate_limited");
    expect(runErrorKind({ errorCode: "Rate_Limited" })).toBe("rate_limited");
    expect(runErrorText({ errorCode: "rate_limited" })).toBe("بلغ حد استخدام الاشتراك لتوليد الصور؛ حاول لاحقًا");
    expect(RATE_LIMIT_TEXT).toBe("بلغ حد استخدام الاشتراك لتوليد الصور؛ حاول لاحقًا");
  });
  it("the legacy provider text is recognised as a fallback (usage_limit_reached / HTTP 429)", () => {
    expect(runErrorKind({ text: "OpenAI Codex image generation failed (HTTP 429) usage_limit_reached" })).toBe("rate_limited");
    expect(runErrorKind({ text: "error: usage_limit_reached" })).toBe("rate_limited");
    expect(runErrorKind({ text: "request failed with HTTP 429" })).toBe("rate_limited");
    expect(runErrorKind({ text: "HTTP 4290" })).toBe("generic");
  });
  it("anything else (or nothing) is the generic message; unknown codes are not acted on", () => {
    expect(runErrorKind({ errorCode: "timeout", text: "boom" })).toBe("generic");
    expect(runErrorKind({ errorCode: 429 as unknown as string })).toBe("generic");
    expect(runErrorKind(null)).toBe("generic");
    expect(runErrorKind(undefined)).toBe("generic");
    expect(runErrorText({ text: "something failed" })).toBe(GENERIC_RUN_ERROR_TEXT);
  });
  it("a rate limit is not offered a resend; other failures are", () => {
    expect(runErrorRetryable({ errorCode: "rate_limited" })).toBe(false);
    expect(runErrorRetryable({ text: "… HTTP 429 …" })).toBe(false);
    expect(runErrorRetryable({ text: "boom" })).toBe(true);
  });
  it("only the provider's own quota notice is rewritten in the history (an answer that merely mentions 429 is left alone)", () => {
    expect(isProviderLimitNotice("OpenAI Codex image generation failed (HTTP 429) usage_limit_reached")).toBe(true);
    expect(isProviderLimitNotice("رمز الخطأ 429 يعني كثرة الطلبات.")).toBe(false);
    expect(isProviderLimitNotice("usage_limit_reached ".repeat(100))).toBe(false); // a long answer is never a notice
    expect(isProviderLimitNotice(undefined)).toBe(false);
  });
});
