import type { Metadata } from "next";
import Link from "next/link";
import Icon from "@/components/icon";
import { PageHeader } from "@/components/ui";
import { NAV } from "@/lib/nav";
import MoreSearchButton from "./search-button";

export const metadata: Metadata = { title: "المزيد" };
const MORE = NAV.filter((n) => ["/integrations", "/calls", "/settings"].includes(n.href));

export default function Page() {
  return (
    <div className="page">
      <PageHeader title="المزيد" />
      <MoreSearchButton />
      <nav className="card" aria-label="أقسام إضافية">
        {MORE.map((n) => (
          <Link key={n.href} href={n.href} className="more-link">
            <span className="file-ico"><Icon name={n.icon} size={22} /></span>
            <span className="grow"><strong>{n.label}</strong><small>{n.hint}</small></span>
            <Icon name="forward" size={18} style={{ color: "var(--muted)" }} />
          </Link>
        ))}
      </nav>
    </div>
  );
}
