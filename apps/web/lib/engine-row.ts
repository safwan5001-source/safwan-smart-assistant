/** How an engine history row reads in its bubble. Pure (testable without rendering). */
import { isPlaceholderOnly } from "./attachment-match";
import { providerLimitNoticeText } from "./run-error";

export type EngineRowView = {
  voice: boolean;
  /** The owner's words: the engine's bare media placeholder («[image]», «User sent image(s) with no text.») is not a caption. */
  text: string;
  /** An owner message with no words, no voice note and no photo still being read from this device: it must show a photo or an honest placeholder. */
  noText: boolean;
  /** The owner's photo copy on this device could not be read: its bubble shows an unavailable tile with a retry, WHETHER OR NOT the message has a caption. */
  localFailed: boolean;
  /** The assistant's text, with the provider's quota notice replaced by the clear Arabic message. */
  assistantText: string;
};
export type LocalPhotoState = "none" | "loading" | "ready" | "failed";
export function engineRowView(m: { role: "user" | "assistant" | "system"; text: string }, parse: (t: string) => { voice: boolean; text: string }, local: LocalPhotoState = "none"): EngineRowView {
  const parsed = m.role === "user" ? parse(m.text) : { voice: false, text: m.text };
  const text = m.role === "user" && isPlaceholderOnly(parsed.text) ? "" : parsed.text;
  return {
    voice: parsed.voice, text,
    noText: m.role === "user" && !text.trim() && !parsed.voice && local !== "loading",
    localFailed: m.role === "user" && local === "failed",
    assistantText: m.role === "assistant" ? providerLimitNoticeText(m.text) ?? m.text : m.text,
  };
}
