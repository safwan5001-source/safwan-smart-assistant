"use client";
/**
 * A link with a long-press action (lib/long-press). A short tap navigates exactly like a plain link. Holding ≥ 450 ms shows a
 * progress ring; releasing after that runs `onLongPress` INSIDE the pointerup handler (iOS user activation for audio/mic) and the
 * following click is swallowed. No context menu, link preview, callout or text selection while pressing (CSS + contextmenu).
 * Keyboard/AT: Shift+Enter on the focused link runs the same action (described by `hint`).
 */
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createLongPress, LONG_PRESS_MS } from "@/lib/long-press";

type Props = Omit<ComponentProps<typeof Link>, "onClick" | "onPointerDown" | "onPointerUp" | "onPointerMove" | "onPointerCancel" | "onPointerLeave" | "onContextMenu" | "onKeyDown"> & {
  onLongPress: () => void;
  /** spoken hint for the long-press / keyboard alternative */
  hint: string;
  children: ReactNode;
};

export default function LongPressLink({ onLongPress, hint, children, className, ...rest }: Props) {
  const [hold, setHold] = useState<"idle" | "holding" | "armed">("idle");
  const act = useRef(onLongPress);
  act.current = onLongPress;
  const ctl = useRef<ReturnType<typeof createLongPress> | null>(null);
  ctl.current ??= createLongPress({
    onHold: setHold,
    onActivate: () => {
      try { navigator.vibrate?.(12); } catch { /* not supported (iOS): no haptics claimed */ }
      act.current();
    },
  });
  const hintId = useId();

  // a scroll while holding is not a press
  useEffect(() => {
    if (hold === "idle") return;
    const stop = () => ctl.current?.cancel();
    window.addEventListener("scroll", stop, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", stop, { capture: true });
  }, [hold]);

  const down = (e: PointerEvent<HTMLAnchorElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    ctl.current?.down(e.pointerId, e.clientX, e.clientY);
  };
  const up = (e: PointerEvent<HTMLAnchorElement>) => {
    if (ctl.current?.up(e.pointerId) === "activate") e.preventDefault();
  };
  const key = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); act.current(); }
  };

  return (
    <Link {...rest} className={(className ? className + " " : "") + "long-press"} data-hold={hold} draggable={false}
      style={{ ["--hold-ms" as string]: `${LONG_PRESS_MS}ms` }}
      aria-describedby={hintId} aria-description={hint}
      onPointerDown={down} onPointerUp={up}
      onPointerMove={(e) => ctl.current?.move(e.pointerId, e.clientX, e.clientY)}
      onPointerCancel={() => ctl.current?.cancel()} onPointerLeave={() => ctl.current?.cancel()}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => { if (ctl.current?.click()) { e.preventDefault(); e.stopPropagation(); } }}
      onKeyDown={key}>
      {children}
      <span className="hold-ring" aria-hidden="true" />
      <span id={hintId} className="sr-only">{hint}</span>
    </Link>
  );
}
