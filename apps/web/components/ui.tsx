import type { ReactNode } from "react";
import Icon, { type IconName } from "./icon";

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head-row">
        <div className="stack" style={{ gap: 4 }}>
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h1>{title}</h1>
        </div>
        {actions}
      </div>
      {description && <p>{description}</p>}
    </header>
  );
}

export function Empty({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={icon} size={26} /></span>
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

export const Badge = ({ tone, children }: { tone?: "ok" | "warn" | "danger" | "info" | "accent"; children: ReactNode }) =>
  <span className={"badge " + (tone ?? "")}>{children}</span>;

export function LogoTile({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return (
    <span className={"logo-tile " + (size === "md" ? "" : size)} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/safwan-logo.svg" alt="" />
    </span>
  );
}
