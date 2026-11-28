/**
 * What the owner sees when a turn ends in an error. The engine tells it apart by a structured `errorCode` (additive field of the
 * run); older engines only leave the provider's text («OpenAI Codex image generation failed (HTTP 429) usage_limit_reached»), which
 * is recognised as a fallback ONLY in that anchored provider form (the text STARTS with it) — a sentence that merely mentions
 * "HTTP 429" is not a rate limit. The provider text itself is never shown. A rate limit is NOT retried automatically and the owner
 * is not offered a one-tap resend: it is a subscription quota, and trying again at once only hits the same wall. The words
 * «لتوليد الصور» are used only when the notice came from an image generation; otherwise the message is generic.
 */
export const RATE_LIMIT_IMAGE_TEXT = "بلغ حد استخدام الاشتراك لتوليد الصور؛ حاول لاحقًا";
export const RATE_LIMIT_TEXT = "بلغ حد استخدام الاشتراك؛ حاول لاحقًا";
export const GENERIC_RUN_ERROR_TEXT = "تعذّر إكمال الرد من باشت. أعد المحاولة.";

export type RunErrorKind = "rate_limited" | "generic";
type RunLike = { errorCode?: unknown; text?: unknown } | null | undefined;
/** The provider's own form: «<provider/tool> failed (HTTP 429) usage_limit_reached», «HTTP 429 …», «usage_limit_reached …», from the start. */
const ANCHORED = /^\s*(?:error:?\s*)?(?:[\w ./-]{0,80}\bfailed\s*)?\(?(?:HTTP\s*429|usage_limit_reached)\b/i;
const IMAGE_NOTICE = /image\s+generation|توليد الصور/i;
const anchoredLimit = (t: unknown) => typeof t === "string" && t.length <= 600 && ANCHORED.test(t);

export function runErrorKind(run: RunLike): RunErrorKind {
  if (typeof run?.errorCode === "string" && run.errorCode.trim().toLowerCase() === "rate_limited") return "rate_limited";
  return anchoredLimit(run?.text) ? "rate_limited" : "generic";
}
export const runErrorText = (run: RunLike): string => {
  if (runErrorKind(run) !== "rate_limited") return GENERIC_RUN_ERROR_TEXT;
  return typeof run?.text === "string" && IMAGE_NOTICE.test(run.text) ? RATE_LIMIT_IMAGE_TEXT : RATE_LIMIT_TEXT;
};
/** A resend would only hit the same limit: no «إعادة المحاولة» for these. */
export const runErrorRetryable = (run: RunLike): boolean => runErrorKind(run) !== "rate_limited";

/** An assistant message that is just the provider's quota notice (anchored, short, with `usage_limit_reached`): its clear Arabic text, else null. */
export const providerLimitNoticeText = (text: unknown): string | null =>
  anchoredLimit(text) && /usage_limit_reached/i.test(text as string) ? (IMAGE_NOTICE.test(text as string) ? RATE_LIMIT_IMAGE_TEXT : RATE_LIMIT_TEXT) : null;
