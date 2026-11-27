"use client";
/**
 * «الدخول والأمان» (A1): the owner's one session — sign in, add Face ID to this device, list/remove devices, sign out here or
 * everywhere. Renders nothing while the server has unified sign-in off, so the legacy per-door codes stay the only path.
 */
import { useCallback, useEffect, useState } from "react";
import Icon from "@/components/icon";
import { Badge, Notice } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import OwnerSignIn from "@/components/owner-sign-in";
import { formatTime } from "@/lib/format";
import { authClient, AuthError, passkeysSupported, type AuthStatus, type Passkey } from "@/lib/owner-auth";

export default function SecuritySettings() {
  const { confirm, prompt, toast } = useDialogs();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const s = await authClient.status();
    setStatus(s);
    if (s.authenticated && s.passkeys) { try { setKeys(await authClient.passkeys()); } catch { setKeys([]); } } else setKeys(null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); toast(ok); await load(); }
    catch (e) { setError(e instanceof AuthError ? e.message : "تعذّر إكمال الطلب."); }
    finally { setBusy(false); }
  };
  const addFaceId = async () => {
    const name = await prompt({ title: "اسم هذا الجهاز", label: "يظهر في قائمة الأجهزة لتعرفه لاحقًا", initial: "iPhone", confirmLabel: "متابعة", maxLength: 60 });
    if (name === null) return;
    await run(() => authClient.registerPasskey(name), "تمت إضافة Face ID لهذا الجهاز");
  };
  const remove = async (k: Passkey) => {
    if (!(await confirm({ title: `إزالة «${k.name}»؟`, message: "لن يتمكن هذا الجهاز من الدخول بـ Face ID بعد الآن. يبقى الدخول برمز المالك متاحًا.", confirmLabel: "إزالة", tone: "danger" }))) return;
    await run(() => authClient.removePasskey(k.id), "أُزيل الجهاز");
  };
  const signOutAll = async () => {
    if (!(await confirm({ title: "الخروج من كل الأجهزة؟", message: "تنتهي كل جلسات المالك فورًا، ومنها هذا الجهاز.", confirmLabel: "خروج من الكل", tone: "danger" }))) return;
    await run(() => authClient.logout(true), "تم الخروج من كل الأجهزة");
  };

  if (!status?.owner_auth) return null;
  return (
    <section className="card card-pad stack" aria-labelledby="sec-h">
      <div className="section-head"><h2 id="sec-h">الدخول والأمان</h2>{status.authenticated ? <Badge tone="ok">مسجَّل الدخول</Badge> : <Badge>غير مسجَّل</Badge>}</div>
      {!status.authenticated ? <OwnerSignIn compact status={status} onSignedIn={() => void load()} /> : (
        <>
          <small className="muted">جلسة مالك واحدة للتطبيق كله. تنتهي بعد 12 ساعة، أو 30 يومًا إذا اخترت «تذكّر هذا الجهاز».</small>
          {status.passkeys ? (
            <div className="stack" style={{ gap: 8 }}>
              <strong>Face ID</strong>
              {keys === null ? <small className="muted">جارٍ التحميل…</small> : keys.length === 0 ? <small className="muted">لا توجد أجهزة مسجّلة بعد.</small> : (
                <ul className="stack" style={{ gap: 6, listStyle: "none", padding: 0, margin: 0 }}>
                  {keys.map((k) => (
                    <li key={k.id} className="row" style={{ justifyContent: "space-between" }}>
                      <span className="stack" style={{ gap: 2 }}><span>{k.name}</span><small className="muted">{k.last_used_at ? `آخر استخدام ${formatTime(Date.parse(k.last_used_at))}` : "لم يُستخدم بعد"}</small></span>
                      <button className="btn btn-sm" onClick={() => void remove(k)} disabled={busy} aria-label={`إزالة ${k.name}`}>إزالة</button>
                    </li>
                  ))}
                </ul>
              )}
              {passkeysSupported()
                ? <button className="btn btn-primary" onClick={() => void addFaceId()} disabled={busy} style={{ justifySelf: "start" }}><Icon name="shield" size={18} />إضافة Face ID لهذا الجهاز</button>
                : <small className="muted">هذا المتصفح لا يدعم مفاتيح المرور.</small>}
            </div>
          ) : <small className="muted">Face ID يُفعَّل بعد ربط النطاق الدائم للتطبيق.</small>}
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => void run(() => authClient.logout(), "تم الخروج من هذا الجهاز")} disabled={busy}>خروج من هذا الجهاز</button>
            <button className="btn" onClick={() => void signOutAll()} disabled={busy}>خروج من كل الأجهزة</button>
          </div>
        </>
      )}
      {error && <Notice tone="warn" role="alert">{error}</Notice>}
    </section>
  );
}
