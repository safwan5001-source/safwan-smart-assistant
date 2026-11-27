"use client";
/** The ONE sign-in of the app (A1): Face ID when this domain has passkeys, or the owner code — optionally remembered for 30 days. */
import { useId, useState, type FormEvent } from "react";
import Icon from "@/components/icon";
import { BrandMark } from "@/components/ui";
import { authClient, AuthError, passkeysSupported, type AuthStatus } from "@/lib/owner-auth";

export default function OwnerSignIn({ status, onSignedIn, compact = false }: { status: AuthStatus; onSignedIn: () => void; compact?: boolean }) {
  const ids = useId();
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState<"code" | "passkey" | null>(null);
  const [error, setError] = useState("");
  const faceId = status.passkeys && passkeysSupported();

  const withCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy("code"); setError("");
    try { await authClient.loginCode(code.trim(), remember); setCode(""); onSignedIn(); }
    catch (err) { setError(err instanceof AuthError ? err.message : "تعذّر الدخول."); }
    finally { setBusy(null); }
  };
  const withPasskey = async () => {
    if (busy) return;
    setBusy("passkey"); setError("");
    try { await authClient.loginPasskey(remember); onSignedIn(); }
    catch (err) { setError(err instanceof AuthError ? err.message : "تعذّر الدخول."); }
    finally { setBusy(null); }
  };

  return (
    <form className={"stack" + (compact ? "" : " card card-pad")} onSubmit={withCode} style={{ gap: 10 }} aria-labelledby={ids + "-t"}>
      <div className="row"><BrandMark size="sm" /><strong id={ids + "-t"}>الدخول إلى باشت</strong></div>
      <small className="muted">دخول واحد للتطبيق كله: المحادثة والمتصفح والإعدادات، بصلاحيات المالك.</small>
      {faceId && (
        <button type="button" className="btn btn-primary btn-block" onClick={() => void withPasskey()} disabled={!!busy}>
          <Icon name="shield" size={18} />{busy === "passkey" ? "جارٍ التحقق…" : "الدخول بـ Face ID"}
        </button>
      )}
      <div className="row">
        <input className="input" type="password" autoComplete="current-password" aria-label="رمز وصول المالك" placeholder={faceId ? "أو رمز المالك" : "رمز وصول المالك"}
          value={code} onChange={(e) => setCode(e.target.value)} style={{ flex: 1 }} dir="ltr" />
        <button className={faceId ? "btn" : "btn btn-primary"} type="submit" disabled={!!busy || !code.trim()}>{busy === "code" ? "…" : "فتح"}</button>
      </div>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>تذكّر هذا الجهاز 30 يومًا</span>
      </label>
      {error && <small role="alert" style={{ color: "var(--danger)" }}>{error}</small>}
    </form>
  );
}
