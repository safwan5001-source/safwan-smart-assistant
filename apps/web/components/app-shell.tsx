"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import Icon from "./icon";
import { AgentOrb, BrandLockup, BrandMark, Ornament } from "./ui";
import SearchDialog from "./search-dialog";
import NotificationBell from "./notification-bell";
import { MORE_PATHS, NAV, TABS, isActive, titleFor } from "@/lib/nav";
import { BRAND } from "@/lib/brand";
import { AGENT_STATE_TEXT, agentState, useAgentActivity } from "@/lib/agent-activity";
import { useAssistant } from "./assistant-context";
import { OwnerGateProvider } from "./owner-gate";
import { LOGIN_PATH } from "@/lib/login-path";
import LongPressLink from "./long-press-link";
import { OPEN_VOICE_EVENT, primeVoiceFromGesture, TAB_VOICE_HINT, VOICE_URL } from "@/lib/voice-launch";

export const OPEN_SEARCH_EVENT = "safwan:open-search";

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // the login page is the app's front door: no navigation, no app chrome, nothing of the app before sign-in
  if (pathname === LOGIN_PATH) return <>{children}</>;
  return <OwnerGateProvider><Shell pathname={pathname}>{children}</Shell></OwnerGateProvider>;
}

function Shell({ children, pathname }: { children: ReactNode; pathname: string }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const router = useRouter();
  const { status, refresh } = useAssistant();
  /** Long-press on the BASHT tab (runs inside the pointerup / keydown gesture): unlock audio + mic there, then open the voice. */
  const launchVoice = () => {
    primeVoiceFromGesture();
    if (pathname === "/chat") window.dispatchEvent(new CustomEvent(OPEN_VOICE_EVENT, { detail: { autostart: true } }));
    else router.push(VOICE_URL);
  };
  const state = agentState(status, useAgentActivity());
  const st = AGENT_STATE_TEXT[state];

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

  return (
    <div className="shell">
      <a className="skip-link" href="#main">تخطَّ إلى المحتوى</a>
      <aside className="sidebar" aria-label="القائمة الرئيسية">
        <Link href="/" className="brand" aria-label={BRAND.full + " — الرئيسية"}>
          <BrandLockup tagline />
        </Link>
        <button className="sidebar-search" onClick={() => setSearchOpen(true)} aria-haspopup="dialog">
          <Icon name="search" size={18} /><span>بحث شامل</span><span className="kbd kbd-hint">⌘K</span>
        </button>
        <nav className="nav" aria-label="الأقسام">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={isActive(pathname, n.href) ? "page" : undefined}>
              <Icon name={n.icon} size={20} />{n.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <section className="agent-card" aria-label="حالة باشت" data-tone={st.tone}>
            <AgentOrb state={state} size="sm" />
            <span className="grow">
              <strong>باشت · <span role="status">{st.label}</span></strong>
              <small>{st.detail}</small>
            </span>
            {(state === "offline" || state === "notes") && (
              <button className="icon-btn sm" onClick={refresh} aria-label="إعادة فحص الاتصال" title="إعادة فحص الاتصال"><Icon name="repeat" size={16} /></button>
            )}
          </section>
          <Ornament />
          <small className="foot-note">نسخة تجريبية · بياناتك على هذا الجهاز</small>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <Link href="/" className="brand-mini" aria-label="الرئيسية"><BrandMark size="sm" /></Link>
          <h2 className="topbar-title">
            {pathname === "/" ? <span className="topbar-brand">{BRAND.nameAr}<small data-tone={st.tone}><i className="state-dot" aria-hidden="true" />{st.label}</small></span> : titleFor(pathname)}
          </h2>
          <button className="icon-btn bordered" onClick={() => setSearchOpen(true)} aria-label="بحث (اختصار: /)" aria-haspopup="dialog"><Icon name="search" size={20} /></button>
          <NotificationBell />
          <Link href="/settings" className="icon-btn bordered mobile-only" aria-label="الإعدادات"><Icon name="settings" size={20} /></Link>
        </header>
        <main id="main" tabIndex={-1}>{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="التنقل السفلي">
        {TABS.map((n) => {
          const active = n.href === "/more" ? MORE_PATHS.some((h) => isActive(pathname, h)) : isActive(pathname, n.href);
          if (n.href === "/chat") {
            return (
              <LongPressLink key={n.href} href={n.href} className="tab-agent" aria-current={active ? "page" : undefined} aria-label={"تحدّث مع باشت — " + st.label}
                hint={TAB_VOICE_HINT} onLongPress={launchVoice}>
                <AgentOrb state={state} size="md" /><span>باشت</span>
              </LongPressLink>
            );
          }
          return <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}><Icon name={n.icon} size={23} /><span>{n.label}</span></Link>;
        })}
      </nav>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
