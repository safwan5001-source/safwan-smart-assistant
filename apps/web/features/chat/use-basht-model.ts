"use client";
/**
 * Model control (M) state for the app conversation. Loaded when the conversation opens and refreshed after each reply and after
 * each change — never polled. `supported === false` means the engine has no model control (older bridge): the UI hides itself.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { bashtClient, BashtError, type BashtModel, type BashtModelState } from "@/lib/basht-client";

export type ModelChange = { kind: "model"; value: string } | { kind: "thinking"; value: string } | { kind: "fast"; value: "on" | "off" | "default" };

export function useBashtModel(open: boolean, replying: boolean) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [models, setModels] = useState<BashtModel[] | null>(null);
  const [state, setState] = useState<BashtModelState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const gen = useRef(0);

  /** Reads the engine. With `settled`, re-reads (≤ ~2 s) until the requested change shows. Returns true only when the state was
   * read AND (if asked) shows the change; `keepError` leaves an error on screen (a refusal must stay visible after the refresh). */
  const load = useCallback(async (withCatalog: boolean, settled?: (s: BashtModelState) => boolean, keepError = false): Promise<boolean> => {
    const my = ++gen.current;
    try {
      const [first, m] = await Promise.all([bashtClient.modelState(), withCatalog ? bashtClient.models() : Promise.resolve(null)]);
      let s = first;
      // the engine applies a session change a moment after acknowledging it: re-read until it shows, never assume it
      for (let i = 0; settled && !settled(s) && i < 4; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (my !== gen.current) return false;
        s = await bashtClient.modelState();
      }
      if (my !== gen.current) return false;
      setState(s); if (m) setModels(m); setSupported(true);
      if (!keepError) setError("");
      return settled ? settled(s) : true;
    } catch (e) {
      if (my !== gen.current) return false;
      if (e instanceof BashtError && e.code === "model_control_unavailable") { setSupported(false); return false; }
      if (!keepError) setError(e instanceof BashtError ? e.message : "تعذّر قراءة إعدادات النموذج.");
      return false;
    }
  }, []);

  useEffect(() => { if (open) void load(true); }, [open, load]);
  // a reply just finished: which model answered (and any fallback) is now known
  const wasReplying = useRef(replying);
  useEffect(() => {
    if (open && wasReplying.current && !replying) void load(false);
    wasReplying.current = replying;
  }, [open, replying, load]);

  /** Applies one change to the app conversation, then re-reads the engine's truth. Returns "" only once the engine SHOWS the
   * change; otherwise an Arabic message (refused, or not confirmed yet) — never a success it cannot see. */
  const apply = useCallback(async (c: ModelChange): Promise<string> => {
    setBusy(true); setError("");
    try {
      try {
        if (c.kind === "model") await bashtClient.setModel(c.value);
        else if (c.kind === "thinking") await bashtClient.setThinking(c.value);
        else await bashtClient.setFast(c.value);
      } catch (e) {
        const msg = e instanceof BashtError ? e.message : "تعذّر تطبيق التغيير.";
        setError(msg);
        await load(false, undefined, true); // show the engine's real state, keep the reason on screen
        return msg;
      }
      const confirmed = await load(c.kind === "model", (s) =>
        c.kind === "model" ? (c.value === "default" ? s.model.source !== "override" : s.model.id === c.value && s.model.source === "override")
        : c.kind === "thinking" ? s.thinking.level === (c.value === "default" ? null : c.value)
        : c.value === "default" || s.fast.enabled === (c.value === "on"));
      if (confirmed) return "";
      const msg = "أرسل التغيير، لكن المحرك لم يؤكده بعد. ما تراه هو حالته الفعلية الآن.";
      setError(msg);
      return msg;
    } finally { setBusy(false); }
  }, [load]);

  return { supported, models, state, busy, error, apply, reload: () => load(true) };
}
