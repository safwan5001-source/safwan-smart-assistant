/**
 * What the owner sees when a turn ends in an error. The engine tells it apart by a structured `errorCode` (additive field of the
 * run); older engines only leave the provider's text («… (HTTP 429) usage_limit_reached»), which is recognised as a fallback.
 * The provider text itself is never shown. A rate limit is NOT retried automatically and the owner is not offered a one-tap resend:
 * it is a subscription quota (image generation), and trying again at once only hits the same wall.
 */
export const RATE_LIMIT_TEXT = "بلغ حد استخدام الاشتراك لتوليد الصور؛ حاول لاحقًا";
export const GENERIC_RUN_ERROR_TEXT = "تعذّر إكمال الرد من باشت. أعد المحاولة.";

export type RunErrorKind = "rate_limited" | "generic";
const LEGACY_RATE_LIMIT = /usage_limit_reached|HTTP\s*429\b/i;

export function runErrorKind(run: { errorCode?: unknown; text?: unknown } | null | undefined): RunErrorKind {
  if (typeof run?.errorCode === "string" && run.errorCode.trim().toLowerCase() === "rate_limited") return "rate_limited";
  if (typeof run?.text === "string" && LEGACY_RATE_LIMIT.test(run.text)) return "rate_limited";
  return "generic";
}
export const runErrorText = (run: { errorCode?: unknown; text?: unknown } | null | undefined): string =>
  runErrorKind(run) === "rate_limited" ? RATE_LIMIT_TEXT : GENERIC_RUN_ERROR_TEXT;
/** A resend would only hit the same limit: no «إعادة المحاولة» for these. */
export const runErrorRetryable = (run: { errorCode?: unknown; text?: unknown } | null | undefined): boolean => runErrorKind(run) !== "rate_limited";

/** An assistant message that is just the provider's quota notice (« … (HTTP 429) usage_limit_reached »): shown as the clear Arabic text instead. */
export const isProviderLimitNotice = (text: unknown): boolean => typeof text === "string" && text.length < 600 && /usage_limit_reached/i.test(text);
