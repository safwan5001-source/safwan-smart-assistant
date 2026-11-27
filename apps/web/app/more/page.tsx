import type { Metadata } from "next";
import Link from "next/link";
import Icon from "@/components/icon";
import { BrandMark, Ornament, PageHeader } from "@/components/ui";
import { NAV } from "@/lib/nav";
import { BRAND } from "@/lib/brand";
import { HQ_ENABLED } from "@/lib/hq/flag";
import MoreSearchButton from "./search-button";

export const metadata: Metadata = { title: "المزيد" };
const GROUPS: { title: string; hrefs: string[] }[] = [
  // with the HQ tab on, الملفات leaves the tab bar and lives here (same route, same on-device library)
  ...(HQ_ENABLED ? [{ title: "المكتبة", hrefs: ["/files"] }] : []),
  { title: "المتابعة", hrefs: ["/reminders", "/notifications"] },
  { title: "باشت", hrefs: ["/calls", "/integrations", "/memory"] },
  { title: "التطبيق", hrefs: ["/settings"] },
];

export default function Page() {
  return (
    <div className="page">
      <PageHeader icon="more" title="المزيد" />
      <MoreSearchButton />
      {GROUPS.map((g) => (
        <section key={g.title} className="stack" style={{ gap: 8 }} aria-label={g.title}>
          <h2 className="eyebrow-title">{g.title}</h2>
          <nav className="card" style={{ overflow: "hidden" }}>
            {NAV.filter((n) => g.hrefs.includes(n.href)).map((n) => (
              <Link key={n.href} href={n.href} className="more-link">
                <span className="file-ico"><Icon name={n.icon} size={22} /></span>
                <span className="grow"><strong>{n.label}</strong><small>{n.hint}</small></span>
                <Icon name="forward" size={18} style={{ color: "var(--muted)" }} />
              </Link>
            ))}
          </nav>
        </section>
      ))}
      <footer className="stack" style={{ justifyItems: "center", gap: 8, paddingBlock: 12 }}>
        <BrandMark size="md" />
        <Ornament />
        <small className="muted">{BRAND.full} · {BRAND.tagline}</small>
      </footer>
    </div>
  );
}
