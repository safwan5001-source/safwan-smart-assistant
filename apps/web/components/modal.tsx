"use client";
import { useEffect, useRef, type ReactNode } from "react";

/** Accessible modal on the native <dialog>: focus trap, Esc, inert background and backdrop click for free. */
export default function Modal({ open, onClose, label, children, variant = "center" }: {
  open: boolean; onClose: () => void; label: string; children: ReactNode; variant?: "center" | "sheet" | "top";
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
      className={variant === "sheet" ? "sheet-dialog" : variant === "top" ? "top-dialog" : undefined}
      onClose={() => closeRef.current()}
      onClick={(e) => { if (e.target === ref.current) closeRef.current(); }}
    >
      {children}
    </dialog>
  );
}
