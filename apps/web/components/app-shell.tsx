"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import Icon from "./icon";
import { LogoTile } from "./ui";
import SearchDialog from "./search-dialog";
import NotificationBell from "./notification-bell";
import { NAV, TABS, isActive, titleFor } from "@/lib/nav";
import { aiReady, useAssistant } from "./assistant-context";

export const OPEN_SEARCH_EVENT = "safwan:open-search";

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);
  const { status } = useAssistant();

  useEffect(() => {
    const open = () => setSearchOpen(true);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); open(); }
    };
    window.addEventListener(OPEN_SEARCH_EVENT, open);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener(OPEN_SEARCH_EVENT, open); window.removeEventListener("keydown", onKey); };
  }, []);

  const serverLabel = status.server === "checking" ? "جارٍ فحص الخادم…" : status.server === "offline" ? "الخادم غير متصل" : "الخادم متصل";
  const aiLabel = aiReady(status) ? "المساعد الذكي مفعّل" : "المساعد الذكي غير مفعّل";

  return (
    <div className="shell">
      <a className="skip-link" href="#main">تخطَّ إلى المحتوى</a>
      <aside className="sidebar" aria-label="القائمة الرئيسية">
        <Link href="/" className="brand" aria-label="مساعد صفوان الذكي — الرئيسية">
          <LogoTile />
          <span><strong>مساعد صفوان</strong><small>المساعد الشخصي الذكي</small></span>
        </Link>
        <nav className="nav" aria-label="الأقسام">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={isActive(pathname, n.href) ? "page" : undefined}>
              <Icon name={n.icon} size={20} />{n.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot" aria-label="حالة النظام">
          <span className="row"><span className={"dot " + (status.server === "online" ? "ok" : status.server === "checking" ? "" : "warn")} />{serverLabel}</span>
          <span className="row"><span className={"dot " + (aiReady(status) ? "ok" : "warn")} />{aiLabel}</span>
          <small>نسخة تجريبية · البيانات على هذا الجهاز</small>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <Link href="/" className="brand-mini" aria-label="الرئيسية"><LogoTile size="sm" /></Link>
          <h2 className="topbar-title">{titleFor(pathname)}</h2>
          <button className="icon-btn bordered" onClick={() => setSearchOpen(true)} aria-label="بحث (اختصار: /)" aria-haspopup="dialog"><Icon name="search" size={20} /></button>
          <NotificationBell />
          <Link href="/settings" className="icon-btn bordered mobile-only" aria-label="الإعدادات"><Icon name="settings" size={20} /></Link>
        </header>
        <main id="main" tabIndex={-1}>{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="التنقل السفلي">
        {TABS.map((n) => {
          const active = n.href === "/more" ? ["/more", "/integrations", "/calls", "/settings", "/reminders", "/notifications"].some((h) => isActive(pathname, h)) : isActive(pathname, n.href);
          return <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}><Icon name={n.icon} size={23} /><span>{n.label}</span></Link>;
        })}
      </nav>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
