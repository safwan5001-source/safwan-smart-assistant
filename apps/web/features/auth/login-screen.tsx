"use client";
/**
 * The app's front door (login gate). Standalone — no navigation, no app data — with BASHT's identity. Signs in through the one
 * owner session (A1) and goes straight to where the owner was heading (`next`), as a full load so the server gate sees the cookie.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import OwnerSignIn from "@/components/owner-sign-in";
import { BrandMark } from "@/components/ui";
import { BRAND, BRAND_ASSETS } from "@/lib/brand";
import { authClient, type AuthStatus } from "@/lib/owner-auth";
import { loginHref, safeNext } from "@/lib/login-path";

export default function LoginScreen() {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    setChecking(true);
    const s = await authClient.status();
    setStatus(s); setChecking(false);
    if (s.authenticated) window.location.replace(next); // already signed in (e.g. another tab)
  }, [next]);
  useEffect(() => { void load(); }, [load]);

  // A notification tapped while the app sits on this page: the service worker focuses this window and posts its destination.
  // Navigation only (no reminders run, nothing of the app shows): it becomes `next`, so signing in lands there.
  const router = useRouter();
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; url?: unknown } | null;
      if (d && d.type === "safwan:navigate" && typeof d.url === "string") router.replace(loginHref(d.url));
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, [router]);

  const unavailable = status !== null && status.unavailable;
  const unconfigured = status !== null && !status.unavailable && status.gate && !status.owner_auth;
  return (
    <main className="login-page" id="main">
      <div className="login-panel">
        <div className="login-brand">
          <BrandMark size="xl" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="login-word on-light" src={BRAND_ASSETS.wordmark} alt={BRAND.nameAr} draggable={false} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="login-word on-dark" src={BRAND_ASSETS.wordmarkWhite} alt="" aria-hidden="true" draggable={false} />
          <p className="login-tagline">{BRAND.tagline}</p>
        </div>

        {params.get("reason") === "expired" && <p className="login-note" role="status">انتهت الجلسة. سجّل الدخول للمتابعة من حيث توقفت.</p>}
        {status === null ? <div className="login-card login-skeleton" aria-busy="true" /> : unconfigured ? (
          <div className="login-card stack" role="alert">
            <strong>الدخول الموحّد غير مهيأ على الخادم</strong>
            <small className="muted">رمز المالك غير مضبوط في خدمة الـ API. يضبطه مسؤول الخادم ثم تعمل هذه الصفحة.</small>
          </div>
        ) : unavailable ? (
          <div className="login-card stack" role="alert">
            <strong>تعذّر الوصول إلى خادم باشت الآن</strong>
            <small className="muted">لم يتغير شيء في حسابك. أعد المحاولة بعد لحظات.</small>
            <button className="btn btn-primary btn-block" onClick={() => void load()} disabled={checking}>{checking ? "جارٍ التحقق…" : "إعادة المحاولة"}</button>
          </div>
        ) : !status.owner_auth ? (
          <div className="login-card stack">
            <strong>الدخول الموحّد غير مفعّل</strong>
            <Link className="btn btn-primary btn-block" href="/">المتابعة إلى التطبيق</Link>
          </div>
        ) : (
          <div className="login-card"><OwnerSignIn bare status={status} onSignedIn={() => window.location.replace(next)} /></div>
        )}

        <p className="login-foot">دخول المالك فقط · جلسة مشفّرة على هذا الجهاز</p>
      </div>
    </main>
  );
}
