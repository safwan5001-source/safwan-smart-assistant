"use client";
import { useEffect, useRef, type ReactNode } from "react";

/** Accessible modal on the native <dialog>: focus trap, Esc, inert background and backdrop click for free. */
export default function Modal({ open, onClose, label, children, variant = "center" }: {
  open: boolean; onClose: () => void; label: string; children: ReactNode; variant?: "center" | "sheet" | "top" | "voice" | "viewer";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dlg = ref.current;
    if (!open || !dlg) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!dlg.open) dlg.showModal();
    return () => {
      document.body.style.overflow = overflow;
      if (dlg.open) dlg.close();
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-label={label}
      className={variant === "sheet" ? "sheet-dialog" : variant === "top" ? "top-dialog" : variant === "voice" ? "voice-dialog" : variant === "viewer" ? "viewer-dialog" : undefined}
      aria-modal="true"
      onClose={() => closeRef.current()}
      // a backdrop click closes a dialog — but never the voice screen (closing it ends the conversation) nor the full-screen viewer
      // (a tap near the picture's edge is not «close»): their own buttons do that
      onClick={(e) => { if (variant !== "voice" && variant !== "viewer" && e.target === ref.current) closeRef.current(); }}
    >
      {children}
    </dialog>
  );
}
