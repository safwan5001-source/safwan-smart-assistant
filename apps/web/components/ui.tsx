import type { ReactNode } from "react";
import Icon, { type IconName } from "./icon";
import { BRAND, BRAND_ASSETS } from "@/lib/brand";
import type { AgentState } from "@/lib/agent-activity";
import type { VoiceState } from "@/lib/voice-state";

export function PageHeader({ eyebrow, title, description, actions, icon }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode; icon?: IconName }) {
  return (
    <header className="page-head">
      <div className="page-head-row">
        <div className="page-head-title">
          {icon && <span className="page-head-icon" aria-hidden="true"><Icon name={icon} size={22} /></span>}
          <div className="stack" style={{ gap: 2 }}>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h1>{title}</h1>
          </div>
        </div>
        {actions}
      </div>
      {description && <p>{description}</p>}
    </header>
  );
}

export function Empty({ icon, title, children, action, brand }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode; brand?: boolean }) {
  return (
    <div className="empty">
      {brand ? <BrandMark size="xl" className="empty-mark" /> : <span className="empty-icon"><Icon name={icon} size={26} /></span>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Notice({ tone = "info", children, role }: { tone?: "info" | "warn" | "danger" | "ok"; children: ReactNode; role?: "alert" | "status" }) {
  return (
    <div className={"notice " + (tone === "info" ? "" : tone)} role={role}>
      <Icon name={tone === "ok" ? "check" : tone === "info" ? "info" : "alert"} size={18} />
      <div>{children}</div>
    </div>
  );
}

export function Skeleton({ h = 16, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} aria-hidden="true" />;
}
export function ListSkeleton({ rows = 3, h = 64 }: { rows?: number; h?: number }) {
  return (
    <div className="stack" role="status" aria-label="جارٍ التحميل">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={h} />)}
    </div>
  );
}

export const Badge = ({ tone, children }: { tone?: "ok" | "warn" | "danger" | "info" | "accent" | "gold"; children: ReactNode }) =>
  <span className={"badge " + (tone ?? "")}>{children}</span>;

/** Design System §6.7 — status is always icon + text, never colour alone. */
export type RunStatus = "draft" | "awaiting_approval" | "running" | "verified" | "done" | "failed" | "cancelled";
const RUN: Record<RunStatus, { label: string; icon: IconName; tone: string }> = {
  draft: { label: "مسودة", icon: "edit", tone: "" },
  awaiting_approval: { label: "بانتظار موافقتك", icon: "hourglass", tone: "warn" },
  running: { label: "جارٍ التنفيذ", icon: "activity", tone: "live" },
  verified: { label: "تم التحقق", icon: "check-circle", tone: "ok" },
  done: { label: "نُفّذ", icon: "check", tone: "ok" },
  failed: { label: "تعذّر", icon: "x-circle", tone: "danger" },
  cancelled: { label: "أُلغي", icon: "close", tone: "" },
};
export function StatusPill({ status, label }: { status: RunStatus; label?: string }) {
  const s = RUN[status];
  return <span className={"status-pill " + s.tone}><Icon name={s.icon} size={14} strokeWidth={2.2} />{label ?? s.label}</span>;
}

/** The official mark (crop of the owner-supplied logo). Decorative wherever the name is also present as text. */
export function BrandMark({ size = "md", className = "", alt = "" }: { size?: "xs" | "sm" | "md" | "lg" | "xl"; className?: string; alt?: string }) {
  const src = size === "xs" || size === "sm" ? BRAND_ASSETS.markSm : BRAND_ASSETS.mark;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className={"brand-mark " + size + (className ? " " + className : "")} src={src} alt={alt} aria-hidden={alt ? undefined : true} decoding="async" draggable={false} />
  );
}

/** Mark + official wordmark drawing (never re-typeset). The white wordmark is the mono treatment for dark surfaces. */
export function BrandLockup({ tone = "auto", tagline = false }: { tone?: "auto" | "light-on-dark"; tagline?: boolean }) {
  return (
    <span className={"brand-lockup " + tone} role="img" aria-label={BRAND.full}>
      <BrandMark size="sm" />
      <span className="brand-words">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="wordmark on-light" src={BRAND_ASSETS.wordmark} alt="" aria-hidden="true" draggable={false} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="wordmark on-dark" src={BRAND_ASSETS.wordmarkWhite} alt="" aria-hidden="true" draggable={false} />
        {tagline && <small>{BRAND.tagline}</small>}
      </span>
    </span>
  );
}

/** Kept for existing call sites: the mark on a soft tile. */
export function LogoTile({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return <span className={"logo-tile " + (size === "md" ? "" : size)} aria-hidden="true"><BrandMark size={size === "lg" ? "lg" : "sm"} /></span>;
}

/** BASHT's face + a ring that reflects the real agent state (animated only while work is actually in flight). */
export function AgentOrb({ state, size = "md" }: { state: AgentState; size?: "sm" | "md" | "lg" | "xl" }) {
  return (
    <span className={"agent-orb " + size} data-state={state} aria-hidden="true">
      <span className="agent-ring" />
      <BrandMark size={size === "sm" ? "sm" : "md"} />
      <span className="agent-dot" />
    </span>
  );
}

/** The voice screen's face: reflects the MICROPHONE only (data-voice), never an agent state — listening is not BASHT replying. */
export function VoiceOrb({ state }: { state: VoiceState }) {
  return (
    <span className="agent-orb voice-face" data-voice={state} aria-hidden="true">
      <span className="agent-ring" />
      <BrandMark size="md" />
      <span className="agent-dot" />
    </span>
  );
}

/** Thin diamond rule echoing the jambiya-sheath motif. Decorative. */
export function Ornament({ className = "" }: { className?: string }) {
  return (
    <svg className={"ornament " + className} viewBox="0 0 120 10" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">
      <path d="M0 5h44M76 5h44" stroke="currentColor" strokeWidth="1" opacity=".5" />
      <path d="M50 5l3-3 3 3-3 3zM57 5l3-4 3 4-3 4zM64 5l3-3 3 3-3 3z" fill="currentColor" />
    </svg>
  );
}
