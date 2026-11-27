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

  const load = useCallback(async (withCatalog: boolean, settled?: (s: BashtModelState) => boolean) => {
    const my = ++gen.current;
    try {
      const [first, m] = await Promise.all([bashtClient.modelState(), withCatalog ? bashtClient.models() : Promise.resolve(null)]);
      let s = first;
      // the engine applies a session change a moment after acknowledging it: re-read (≤ ~2 s) until it shows, never assume it
      for (let i = 0; settled && !settled(s) && i < 4; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (my !== gen.current) return;
        s = await bashtClient.modelState();
      }
      if (my !== gen.current) return;
      setState(s); if (m) setModels(m); setSupported(true); setError("");
    } catch (e) {
      if (my !== gen.current) return;
      if (e instanceof BashtError && e.code === "model_control_unavailable") { setSupported(false); return; }
      setError(e instanceof BashtError ? e.message : "تعذّر قراءة إعدادات النموذج.");
    }
  }, []);

  useEffect(() => { if (open) void load(true); }, [open, load]);
  // a reply just finished: which model answered (and any fallback) is now known
  const wasReplying = useRef(replying);
  useEffect(() => {
    if (open && wasReplying.current && !replying) void load(false);
    wasReplying.current = replying;
  }, [open, replying, load]);

  /** Applies one change to the app conversation, then re-reads the engine's truth. Returns "" or an Arabic error. */
  const apply = useCallback(async (c: ModelChange): Promise<string> => {
    setBusy(true); setError("");
    try {
      if (c.kind === "model") await bashtClient.setModel(c.value);
      else if (c.kind === "thinking") await bashtClient.setThinking(c.value);
      else await bashtClient.setFast(c.value);
      await load(c.kind === "model", (s) =>
        c.kind === "model" ? (c.value === "default" ? s.model.source === "default" : s.model.id === c.value)
        : c.kind === "thinking" ? s.thinking.level === (c.value === "default" ? null : c.value)
        : c.value === "default" || s.fast.enabled === (c.value === "on"));
      return "";
    } catch (e) {
      const msg = e instanceof BashtError ? e.message : "تعذّر تطبيق التغيير.";
      setError(msg);
      await load(false);
      return msg;
    } finally { setBusy(false); }
  }, [load]);

  return { supported, models, state, busy, error, apply, reload: () => load(true) };
}
