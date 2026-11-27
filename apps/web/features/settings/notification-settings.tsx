"use client";
import { useCallback, useEffect, useState } from "react";
import Icon from "@/components/icon";
import { Badge, Notice } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { useStore } from "@/lib/hooks";
import { prefsStore } from "@/lib/stores";
import { audioPlayer, type PlayResult } from "@/lib/audio";
import { speaker } from "@/lib/speak";
import { CATEGORIES, SOUNDS, type SoundCategory, type SoundId } from "@/lib/sounds";
import { deliverAlert } from "@/lib/alerts";
import { LEAD_OPTIONS, leadLabel } from "@/lib/reminders";
import { DEFAULT_TZ, TZ_LABEL } from "@/lib/tz";
import { detectCaps, disablePush, enablePush, getPushState, sendTestPush, type PushState } from "@/lib/push-client";
import type { NotifyPrefs } from "@/lib/notify-prefs";
import BashtAlertsRow, { linkBashtAlerts } from "./basht-alerts-row";

const PLAY_MSG: Record<PlayResult, string> = {
  played: "", muted: "الصوت مكتوم (مستوى الصوت صفر).", blocked: "منع المتصفح تشغيل الصوت. المس الشاشة ثم أعد المحاولة.",
  unsupported: "صيغة الصوت غير مدعومة في هذا المتصفح.", error: "تعذر تشغيل الصوت.",
};
const STATE_BADGE: Record<PushState, { tone?: "ok" | "warn" | "danger" | "info"; label: string }> = {
  on: { tone: "ok", label: "مفعّلة" }, off: { label: "غير مفعّلة" }, denied: { tone: "danger", label: "محظورة" },
  needs_install: { tone: "warn", label: "تتطلب التثبيت" }, unsupported: { tone: "warn", label: "غير مدعومة" },
  unconfigured: { tone: "warn", label: "الخادم غير مهيأ" }, error: { tone: "danger", label: "خطأ" },
};

export default function NotificationSettings() {
  const prefs = useStore(prefsStore);
  const { toast } = useDialogs();
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [silentSwitch, setSilentSwitch] = useState<boolean | null>(null);
  const [soundMsg, setSoundMsg] = useState("");
  const [speakMsg, setSpeakMsg] = useState("");
  const [deviceTz, setDeviceTz] = useState<string | null>(null);
  const set = useCallback((patch: Partial<NotifyPrefs>) => prefsStore.set((p) => ({ ...p, ...patch })), []);

  const refresh = useCallback(() => { void getPushState().then(setState); }, []);
  useEffect(() => {
    refresh();
    setSilentSwitch(audioPlayer().respectsSilentSwitch());
    try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; if (z && z !== DEFAULT_TZ) setDeviceTz(z); } catch { /* ignore */ }
  }, [refresh]);

  const enable = async () => { setBusy(true); const s = await enablePush(); setState(s); setBusy(false); if (s === "on") { toast("تم تفعيل الإشعارات على هذا الجهاز"); void linkBashtAlerts(); } };
  const disable = async () => { setBusy(true); setState(await disablePush()); setBusy(false); toast("تم إيقاف الإشعارات على هذا الجهاز"); };
  const test = async () => {
    setBusy(true); const r = await sendTestPush(); setBusy(false);
    if (r === "sent") toast("أُرسل الإشعار التجريبي — يجب أن يصل خلال ثوانٍ");
    else if (r === "rate_limited") toast("حاول بعد دقيقة", "error");
    else if (r === "expired") { toast("انتهى اشتراك هذا الجهاز؛ فعّل الإشعارات من جديد", "error"); refresh(); }
    else toast("تعذر إرسال الإشعار التجريبي", "error");
  };
  const preview = async (id: SoundId) => { const r = await audioPlayer().play(id, { volume: prefs.volume }); setSoundMsg(PLAY_MSG[r]); };
  const speakTest = async () => {
    const r = await speaker().speak("تذكير: مراجعة الفواتير، بعد عشر دقائق", { volume: prefs.volume });
    setSpeakMsg(r === "spoken" ? "" : r === "unsupported" ? "متصفحك لا يدعم النطق." : r === "no_voice" ? "لا يوجد صوت عربي مثبّت على هذا الجهاز." : "تعذر النطق. المس الشاشة ثم أعد المحاولة.");
  };
  const inApp = async () => {
    const o = await deliverAlert({ key: `test:${Date.now()}`, type: "system", priority: "normal", title: "تنبيه تجريبي", body: "هذا ما يبدو عليه التنبيه داخل التطبيق.", href: "/notifications", category: "notification", spoken: "هذا تنبيه تجريبي" });
    if (o.sound === "blocked") toast("الصوت محجوب حتى تلمس الشاشة", "error");
  };

  const caps = typeof window === "undefined" ? null : detectCaps();
  const badge = state === "loading" ? null : STATE_BADGE[state];

  return (
    <>
      <section className="card card-pad stack" aria-labelledby="push-h">
        <div className="section-head"><h2 id="push-h">إشعارات الجهاز</h2>{badge && <Badge tone={badge.tone}>{badge.label}</Badge>}</div>
        <p className="muted" style={{ fontSize: 14 }}>تصلك التذكيرات كإشعارات على iPhone حتى والتطبيق مغلق. تُشفَّر الرسائل من الخادم إلى جهازك، ولا يظهر نص التذكير على الشاشة المقفلة ما لم تسمح بذلك أدناه.</p>
        {state === "needs_install" && (
          <Notice tone="warn"><strong>على iPhone تعمل الإشعارات فقط بعد تثبيت التطبيق على الشاشة الرئيسية.</strong>
            <ol className="steps">
              <li>افتح هذه الصفحة في Safari.</li>
              <li>اضغط زر المشاركة <Icon name="forward" size={14} style={{ display: "inline", verticalAlign: "middle" }} /> ثم «إضافة إلى الشاشة الرئيسية».</li>
              <li>افتح «باشت» (أو «صفوان» إن ثبّتّه قبل تغيير الاسم) من الشاشة الرئيسية، وارجع إلى الإعدادات هنا.</li>
              <li>اضغط «تفعيل الإشعارات» واسمح بها عندما يسألك iOS.</li>
            </ol>
            يتطلب iOS 16.4 أو أحدث.</Notice>
        )}
        {state === "unsupported" && <Notice tone="warn">هذا المتصفح أو الإصدار لا يدعم إشعارات الويب. على iPhone يلزم iOS 16.4 أو أحدث مع التطبيق المثبّت. ستظل التنبيهات تعمل داخل التطبيق وهو مفتوح.</Notice>}
        {state === "unconfigured" && <Notice tone="warn">خادم الإشعارات غير مهيأ بعد (مفاتيح VAPID وقاعدة البيانات). التنبيهات داخل التطبيق تعمل، لكن لن تصلك إشعارات والتطبيق مغلق حتى يُفعَّل الخادم.</Notice>}
        {state === "denied" && <Notice tone="danger">الإشعارات محظورة لهذا التطبيق. فعّلها من إعدادات iPhone ← الإشعارات ← باشت أو صفوان (أو من إعدادات الموقع في المتصفح)، ثم عد إلى هنا.</Notice>}
        {state === "error" && <Notice tone="danger" role="alert">تعذر قراءة حالة الإشعارات. تحقق من الاتصال وحاول مجدداً.</Notice>}
        <div className="row-wrap">
          {(state === "off" || state === "error") && <button className="btn btn-primary" disabled={busy} onClick={() => void enable()}><Icon name="bell" size={18} />تفعيل الإشعارات</button>}
          {state === "on" && <>
            <button className="btn" disabled={busy} onClick={() => void test()}><Icon name="send" size={18} />إرسال إشعار تجريبي</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void disable()}>إيقاف الإشعارات</button>
          </>}
          {state === "denied" && <button className="btn" onClick={refresh}>إعادة الفحص</button>}
        </div>
        <div className="setting-row"><span><strong>إظهار نص التذكير على الشاشة المقفلة</strong><small>مغلق افتراضياً: يظهر «لديك تذكير» فقط حفاظاً على خصوصيتك. عند التفعيل يظهر عنوان التذكير لكل من يرى شاشتك.</small></span>
          <label className="switch"><input type="checkbox" role="switch" checked={prefs.lockScreenContent} onChange={(e) => set({ lockScreenContent: e.target.checked })} aria-label="إظهار نص التذكير على الشاشة المقفلة" /></label></div>
        {state === "on" && <BashtAlertsRow />}
        {caps?.ios && caps.standalone && <small className="muted">ملاحظة: يحدد iOS صوت إشعارات الويب (الصوت الافتراضي للنظام) ولا يسمح للتطبيق بتغييره. النغمات المخصصة أدناه تُسمع أثناء فتح التطبيق.</small>}
      </section>

      <section className="card card-pad stack" aria-labelledby="sound-h">
        <h2 id="sound-h">الأصوات والتنبيه الصوتي</h2>
        <div className="setting-row"><span><strong>تشغيل نغمة عند التنبيه</strong><small>أثناء فتح التطبيق</small></span>
          <label className="switch"><input type="checkbox" role="switch" checked={prefs.soundEnabled} onChange={(e) => set({ soundEnabled: e.target.checked })} aria-label="تشغيل نغمة عند التنبيه" /></label></div>
        <div className="field"><label htmlFor="vol">مستوى الصوت: <bdi className="num">{Math.round(prefs.volume * 100)}%</bdi></label>
          <input id="vol" className="range" type="range" min={0} max={1} step={0.05} value={prefs.volume} onChange={(e) => set({ volume: Number(e.target.value) })} /></div>
        {CATEGORIES.map((c) => (
          <div key={c.id} className="tone-row">
            <div className="field" style={{ flex: 1 }}><label htmlFor={`tone-${c.id}`}>{c.label}<small style={{ display: "block", fontWeight: 400 }}>{c.hint}</small></label>
              <select id={`tone-${c.id}`} className="select" value={prefs.tones[c.id]} onChange={(e) => set({ tones: { ...prefs.tones, [c.id as SoundCategory]: e.target.value as SoundId } })}>
                {SOUNDS.map((s) => <option key={s.id} value={s.id}>{s.arabic}</option>)}</select></div>
            <button className="icon-btn bordered" onClick={() => void preview(prefs.tones[c.id])} aria-label={`استمع إلى نغمة ${c.label}`}><Icon name="play" size={18} /></button>
          </div>
        ))}
        {soundMsg && <p role="status" style={{ color: "var(--danger)", fontSize: 13.5 }}>{soundMsg}</p>}
        <Notice tone={silentSwitch ? "ok" : "info"}>{silentSwitch === null ? "جارٍ فحص دعم زر الصامت…" : silentSwitch
          ? "يحترم التطبيق زر الصامت في iPhone: لن تُسمع النغمات والجهاز في الوضع الصامت."
          : "لا يدعم هذا المتصفح ربط الصوت بزر الصامت؛ قد تُسمع النغمة رغم الوضع الصامت."}</Notice>
        <div className="setting-row"><span><strong>نطق التذكير بصوت عربي</strong><small>يقرأ نص التذكير بصوت الجهاز أثناء فتح التطبيق (اختياري)</small></span>
          <label className="switch"><input type="checkbox" role="switch" checked={prefs.speak} onChange={(e) => set({ speak: e.target.checked })} aria-label="نطق التذكير" /></label></div>
        {prefs.speak && <div className="row-wrap"><button className="btn btn-sm" onClick={() => void speakTest()}><Icon name="volume" size={16} />جرّب النطق</button>{speakMsg && <small role="status" style={{ color: "var(--danger)" }}>{speakMsg}</small>}</div>}
        <button className="btn" style={{ justifySelf: "start" }} onClick={() => void inApp()}><Icon name="bell" size={18} />جرّب تنبيهاً داخل التطبيق</button>
      </section>

      <section className="card card-pad stack" aria-labelledby="quiet-h">
        <h2 id="quiet-h">أوقات الهدوء</h2>
        <div className="setting-row"><span><strong>تفعيل أوقات الهدوء</strong><small>لا أصوات ولا نطق ولا إشعارات دفع خلالها؛ يصلك ما فاتك بعد انتهائها.</small></span>
          <label className="switch"><input type="checkbox" role="switch" checked={prefs.quiet.enabled} onChange={(e) => set({ quiet: { ...prefs.quiet, enabled: e.target.checked } })} aria-label="تفعيل أوقات الهدوء" /></label></div>
        {prefs.quiet.enabled && <>
          <div className="grid grid-2">
            <div className="field"><label htmlFor="q-from">من</label><input id="q-from" className="input" type="time" value={prefs.quiet.from} onChange={(e) => e.target.value && set({ quiet: { ...prefs.quiet, from: e.target.value } })} /></div>
            <div className="field"><label htmlFor="q-to">إلى</label><input id="q-to" className="input" type="time" value={prefs.quiet.to} onChange={(e) => e.target.value && set({ quiet: { ...prefs.quiet, to: e.target.value } })} /></div>
          </div>
          <div className="setting-row"><span><strong>السماح للتنبيهات الحرجة</strong><small>التذكيرات بأهمية «حرجة» تتجاوز أوقات الهدوء</small></span>
            <label className="switch"><input type="checkbox" role="switch" checked={prefs.quiet.allowCritical} onChange={(e) => set({ quiet: { ...prefs.quiet, allowCritical: e.target.checked } })} aria-label="السماح للتنبيهات الحرجة" /></label></div>
        </>}
      </section>

      <section className="card card-pad stack" aria-labelledby="def-h">
        <h2 id="def-h">التذكيرات الافتراضية</h2>
        <div className="grid grid-2">
          <div className="field"><label htmlFor="d-lead">التنبيه المسبق الافتراضي</label>
            <select id="d-lead" className="select" value={prefs.defaultLeadMinutes} onChange={(e) => set({ defaultLeadMinutes: Number(e.target.value) })}>
              {LEAD_OPTIONS.map((m) => <option key={m} value={m}>{leadLabel(m)}</option>)}</select></div>
          <div className="field"><label htmlFor="d-tz">المنطقة الزمنية</label>
            <select id="d-tz" className="select" value={prefs.tz} onChange={(e) => set({ tz: e.target.value })}>
              <option value={DEFAULT_TZ}>{TZ_LABEL(DEFAULT_TZ)}</option>{deviceTz && <option value={deviceTz}>{deviceTz} (جهازك)</option>}</select></div>
        </div>
      </section>
    </>
  );
}
