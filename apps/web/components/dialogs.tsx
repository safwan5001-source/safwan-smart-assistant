"use client";
import { createContext, useCallback, useContext, useId, useMemo, useRef, useState, type ReactNode } from "react";
import Modal from "./modal";
import Icon from "./icon";

type ConfirmOpts = { title: string; message?: string; confirmLabel?: string; tone?: "default" | "danger"; requireText?: string };
type PromptOpts = { title: string; label: string; initial?: string; confirmLabel?: string; multiline?: boolean; maxLength?: number };
type Toast = { id: number; text: string; kind: "ok" | "error" };
type Api = {
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  prompt: (o: PromptOpts) => Promise<string | null>;
  toast: (text: string, kind?: "ok" | "error") => void;
};
const Ctx = createContext<Api | null>(null);
export const useDialogs = (): Api => {
  const c = useContext(Ctx);
  if (!c) throw new Error("DialogsProvider missing");
  return c;
};

type Pending =
  | { type: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { type: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void };

export function DialogsProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const confirm = useCallback((opts: ConfirmOpts) => new Promise<boolean>((resolve) => setPending({ type: "confirm", opts, resolve })), []);
  const prompt = useCallback((opts: PromptOpts) => new Promise<string | null>((resolve) => setPending({ type: "prompt", opts, resolve })), []);
  const toast = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);
  const api = useMemo(() => ({ confirm, prompt, toast }), [confirm, prompt, toast]);

  const finish = (value: boolean | string | null) => {
    setPending((p) => {
      if (p) (p.resolve as (v: boolean | string | null) => void)(p.type === "confirm" ? value === true : (value as string | null));
      return null;
    });
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      {pending?.type === "confirm" && <ConfirmDialog opts={pending.opts} onDone={(v) => finish(v)} />}
      {pending?.type === "prompt" && <PromptDialog opts={pending.opts} onDone={(v) => finish(v)} />}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={"toast " + (t.kind === "error" ? "error" : "")}>
            <Icon name={t.kind === "error" ? "alert" : "check"} size={18} />
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ConfirmDialog({ opts, onDone }: { opts: ConfirmOpts; onDone: (v: boolean) => void }) {
  const [typed, setTyped] = useState("");
  const id = useId();
  const blocked = Boolean(opts.requireText) && typed.trim() !== opts.requireText;
  return (
    <Modal open onClose={() => onDone(false)} label={opts.title}>
      <div className="dialog-card" role="alertdialog" aria-describedby={id}>
        <h2>{opts.title}</h2>
        {opts.message && <p id={id} className="muted">{opts.message}</p>}
        {opts.requireText && (
          <div className="field">
            <label htmlFor={id + "t"}>للتأكيد اكتب: <strong>{opts.requireText}</strong></label>
            <input id={id + "t"} className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="off" />
          </div>
        )}
        <div className="dialog-actions">
          <button className={"btn " + (opts.tone === "danger" ? "btn-danger" : "btn-primary")} disabled={blocked} onClick={() => onDone(true)}>{opts.confirmLabel ?? "تأكيد"}</button>
          <button className="btn" autoFocus onClick={() => onDone(false)}>إلغاء</button>
        </div>
      </div>
    </Modal>
  );
}

function PromptDialog({ opts, onDone }: { opts: PromptOpts; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(opts.initial ?? "");
  const id = useId();
  const submit = () => { if (value.trim()) onDone(value); };
  return (
    <Modal open onClose={() => onDone(null)} label={opts.title}>
      <form className="dialog-card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2>{opts.title}</h2>
        <div className="field">
          <label htmlFor={id}>{opts.label}</label>
          {opts.multiline
            ? <textarea id={id} className="textarea" rows={4} autoFocus value={value} maxLength={opts.maxLength} onChange={(e) => setValue(e.target.value)} />
            : <input id={id} className="input" autoFocus value={value} maxLength={opts.maxLength} onChange={(e) => setValue(e.target.value)} />}
        </div>
        <div className="dialog-actions">
          <button type="submit" className="btn btn-primary" disabled={!value.trim()}>{opts.confirmLabel ?? "حفظ"}</button>
          <button type="button" className="btn" onClick={() => onDone(null)}>إلغاء</button>
        </div>
      </form>
    </Modal>
  );
}
