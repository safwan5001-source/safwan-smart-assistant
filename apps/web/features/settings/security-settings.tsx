"use client";
/**
 * «الدخول والأمان»: the owner's sessions and devices. Lists every live session by device (this one marked), ends any one of them,
 * signs out here or everywhere — then clears this device's private data and goes to the login page. Face ID (passkeys) is managed
 * here once the permanent domain is set: adding one asks for the owner code again (step-up), and all of them can be removed at once.
 * Renders nothing while unified sign-in is off (legacy per-door codes).
 */
import { useCallback, useEffect, useState } from "react";
import Icon from "@/components/icon";
import { Badge, Notice } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { useOwnerGate } from "@/components/owner-gate";
import { formatTime } from "@/lib/format";
import { LOGIN_PATH } from "@/lib/login-path";
import { authClient, AuthError, passkeysSupported, type AuthStatus, type OwnerSession, type Passkey } from "@/lib/owner-auth";
import { clearPrivateData, signOut } from "@/lib/sign-out";

const WIPE_NOTE = "تُمسح من هذا الجهاز بياناته المحلية: المهام والمحادثات المحلية والتذكيرات والإشعارات والملفات.";

const when = (iso: string | null) => (iso ? formatTime(Date.parse(iso)) : "");

export default function SecuritySettings() {
  const { confirm, prompt, toast } = useDialogs();
  const ownerGate = useOwnerGate();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [sessions, setSessions] = useState<OwnerSession[] | null>(null);
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const s = await authClient.status();
    setStatus(s);
    if (!s.owner_auth || !s.authenticated) return;
    const [list, pk] = await Promise.all([authClient.sessions().catch(() => null), s.passkeys ? authClient.passkeys().catch(() => []) : Promise.resolve(null)]);
    setSessions(list); setKeys(pk);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (status && !status.unavailable && status.owner_auth && !status.authenticated) ownerGate.signInAgain(); }, [status, ownerGate]);

  const run = async (fn: () => Promise<boolean | void>, ok: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const signedOut = await fn();
      if (signedOut === true) { window.location.assign(LOGIN_PATH); return; }
      toast(ok); await load();
    } catch (e) { setError(e instanceof AuthError ? e.message : "تعذّر إكمال الطلب."); }
    finally { setBusy(false); }
  };
  const end = async (x: OwnerSession) => {
    if (!(await confirm({ title: `إنهاء جلسة «${x.device ?? "جهاز"}»؟`, message: "يُطلب الدخول من جديد على ذلك الجهاز.", confirmLabel: "إنهاء الجلسة", tone: "danger" }))) return;
    await run(async () => { const own = await authClient.endSession(x.id); if (own) await clearPrivateData(); return own; }, "أُنهيت الجلسة");
  };
  const signOutAll = async () => {
    if (!(await confirm({ title: "الخروج من كل الأجهزة؟", message: `تنتهي كل جلسات المالك فورًا، ومنها هذا الجهاز. تبقى أجهزة Face ID مسجّلة (أزلها من قسم Face ID إن لزم). ${WIPE_NOTE}`, confirmLabel: "خروج من الكل", tone: "danger" }))) return;
    await run(() => signOut(true), "");
  };
  const signOutHere = async () => {
    if (!(await confirm({ title: "الخروج من هذا الجهاز؟", message: WIPE_NOTE, confirmLabel: "خروج", tone: "danger" }))) return;
    await run(() => signOut(), "");
  };
  const addFaceId = async () => {
    const name = await prompt({ title: "اسم هذا الجهاز", label: "يظهر في قائمة الأجهزة لتعرفه لاحقًا", initial: "iPhone", confirmLabel: "متابعة", maxLength: 60 });
    if (name === null) return;
    // step-up: adding a lasting sign-in method needs the owner code again (a session alone is not enough)
    const code = await prompt({ title: "أكّد رمز المالك", label: "لإضافة Face ID أدخل رمز المالك مرة أخرى", confirmLabel: "متابعة", maxLength: 256, secret: true });
    if (code === null) return;
    await run(() => authClient.registerPasskey(name, code.trim()), "تمت إضافة Face ID لهذا الجهاز");
  };
  const removeAllKeys = async () => {
    if (!(await confirm({ title: "إزالة كل أجهزة Face ID؟", message: "لن يتمكن أي جهاز من الدخول بـ Face ID بعد الآن. يبقى الدخول برمز المالك متاحًا.", confirmLabel: "إزالة الكل", tone: "danger" }))) return;
    await run(() => authClient.removeAllPasskeys(), "أُزيلت كل أجهزة Face ID");
  };
  const removeKey = async (k: Passkey) => {
    if (!(await confirm({ title: `إزالة «${k.name}»؟`, message: "لن يتمكن هذا الجهاز من الدخول بـ Face ID بعد الآن. يبقى الدخول برمز المالك متاحًا.", confirmLabel: "إزالة", tone: "danger" }))) return;
    await run(() => authClient.removePasskey(k.id), "أُزيل الجهاز");
  };

  if (status?.unavailable) return <section className="card card-pad"><Notice tone="warn" role="status">تعذّر الوصول إلى الخادم الآن؛ لم تتغير جلستك. أعد المحاولة بعد لحظات.</Notice></section>;
  if (!status?.owner_auth || !status.authenticated) return null;
  return (
    <section className="card card-pad stack" aria-labelledby="sec-h">
      <div className="section-head"><h2 id="sec-h">الدخول والأمان</h2><Badge tone="ok">مسجَّل الدخول</Badge></div>
      <small className="muted">جلسة مالك واحدة للتطبيق كله. تنتهي بعد 12 ساعة، أو 30 يومًا إذا اخترت «تذكّر هذا الجهاز».</small>

      <div className="stack" style={{ gap: 8 }}>
        <strong>الجلسات النشطة</strong>
        {sessions === null ? <small className="muted">جارٍ التحميل…</small> : (
          <ul className="session-list" aria-label="الجلسات النشطة">
            {sessions.map((x) => (
              <li key={x.id} className="session-row">
                <Icon name={/آيفون|أندرويد|آيباد/.test(x.device ?? "") ? "phone" : "server"} size={20} />
                <span className="stack" style={{ gap: 2, minWidth: 0, flex: 1 }}>
                  <span className="row" style={{ gap: 6 }}><strong>{x.device ?? "جهاز"}</strong>{x.current && <Badge tone="accent">هذا الجهاز</Badge>}</span>
                  <small className="muted">{x.last_seen_at ? `آخر نشاط ${when(x.last_seen_at)}` : `بدأت ${when(x.created_at)}`} · {x.remember ? "متذكَّر 30 يومًا" : "جلسة 12 ساعة"} · تنتهي {when(x.expires_at)}</small>
                </span>
                {x.current
                  ? <button className="btn btn-sm" onClick={() => void signOutHere()} disabled={busy}>خروج</button>
                  : <button className="btn btn-sm" onClick={() => void end(x)} disabled={busy} aria-label={`إنهاء جلسة ${x.device ?? "جهاز"}`}>إنهاء</button>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="stack" style={{ gap: 8 }}>
        <strong>Face ID</strong>
        {!status.passkeys ? <small className="muted">يُفعَّل بعد ربط النطاق الدائم للتطبيق.</small> : (
          <>
            {keys === null ? <small className="muted">جارٍ التحميل…</small> : keys.length === 0 ? <small className="muted">لا توجد أجهزة مسجّلة بعد.</small> : (
              <ul className="session-list">
                {keys.map((k) => (
                  <li key={k.id} className="session-row">
                    <Icon name="shield" size={20} />
                    <span className="stack" style={{ gap: 2, flex: 1 }}><strong>{k.name}</strong><small className="muted">{k.last_used_at ? `آخر استخدام ${when(k.last_used_at)}` : "لم يُستخدم بعد"}</small></span>
                    <button className="btn btn-sm" onClick={() => void removeKey(k)} disabled={busy} aria-label={`إزالة ${k.name}`}>إزالة</button>
                  </li>
                ))}
              </ul>
            )}
            {passkeysSupported()
              ? <button className="btn" onClick={() => void addFaceId()} disabled={busy} style={{ justifySelf: "start" }}><Icon name="shield" size={18} />إضافة Face ID لهذا الجهاز</button>
              : <small className="muted">هذا المتصفح لا يدعم مفاتيح المرور.</small>}
            {keys !== null && keys.length > 0 && <button className="btn" onClick={() => void removeAllKeys()} disabled={busy} style={{ justifySelf: "start" }}>إزالة كل أجهزة Face ID</button>}
          </>
        )}
      </div>

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => void signOutHere()} disabled={busy}>خروج من هذا الجهاز</button>
        <button className="btn" onClick={() => void signOutAll()} disabled={busy}>خروج من كل الأجهزة</button>
      </div>
      {error && <Notice tone="warn" role="alert">{error}</Notice>}
    </section>
  );
}
