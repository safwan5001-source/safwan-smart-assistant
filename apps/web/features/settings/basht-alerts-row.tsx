"use client";
/**
 * B4 — «تنبيهات باشت» on this device: approvals waiting for you, a reply that finished while the app was closed, a failed automation,
 * BASHT offline for more than 2 minutes. Linking needs BOTH the owner session and this device's push registration
 * (/api/basht/push), so only the owner's own devices ever receive BASHT pushes.
 */
import { useEffect, useState } from "react";
import { pushDeviceStore } from "@/lib/stores";
import { useStore } from "@/lib/hooks";
import { approvalsClient, ApprovalError } from "@/lib/basht-approvals";
import { useDialogs } from "@/components/dialogs";

// The automatic link (when push is turned on) runs outside the row: its result is published here, and a read of the switch that
// started before it finished is ignored, so the switch shows what the server now holds.
let linkSeq = 0;
const linkSubs = new Set<(linked: boolean) => void>();
export const onBashtAlertsLinked = (fn: (linked: boolean) => void) => { linkSubs.add(fn); return () => { linkSubs.delete(fn); }; };
export const bashtAlertsLinkSeq = () => linkSeq;

/** Best effort, after the owner turned push on: link this device to BASHT alerts (owner session required server-side). */
export async function linkBashtAlerts(): Promise<boolean> {
  const d = pushDeviceStore.getSnapshot();
  if (!d?.subscribed) return false;
  let linked: boolean;
  try { linked = await approvalsClient.setPushLinked(d, true); } catch { return false; }
  linkSeq++;
  for (const fn of linkSubs) fn(linked);
  return linked;
}

export default function BashtAlertsRow() {
  const device = useStore(pushDeviceStore);
  const { toast } = useDialogs();
  const [on, setOn] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => onBashtAlertsLinked((v) => { setOn(v); setNote(""); }), []);
  useEffect(() => {
    if (!device?.subscribed) { setOn(null); return; }
    let alive = true;
    const seq = linkSeq; // an automatic link that finishes meanwhile wins over this (possibly older) read
    approvalsClient.pushLinked(device).then((v) => { if (alive && seq === linkSeq) { setOn(v); setNote(""); } })
      .catch((e) => { if (alive) { setOn(null); setNote(e instanceof ApprovalError && e.code === "unauthorized" ? "سجّل الدخول لربط تنبيهات باشت بهذا الجهاز." : e instanceof Error ? e.message : ""); } });
    return () => { alive = false; };
  }, [device]);
  if (!device?.subscribed) return null;
  const toggle = async (v: boolean) => {
    setBusy(true);
    try { setOn(await approvalsClient.setPushLinked(device, v)); toast(v ? "ستصلك تنبيهات باشت على هذا الجهاز" : "أُوقفت تنبيهات باشت على هذا الجهاز"); }
    catch (e) { toast(e instanceof Error ? e.message : "تعذّر الحفظ", "error"); }
    finally { setBusy(false); }
  };
  return (
    <div className="setting-row"><span><strong>تنبيهات باشت</strong>
      <small>{note || "طلب موافقة ينتظرك، رد جاهز والتطبيق مغلق، مهمة مجدولة فشلت، أو انقطاع باشت أكثر من دقيقتين. بلا نص الأوامر أو الردود على الشاشة المقفلة."}</small></span>
      <label className="switch"><input type="checkbox" role="switch" checked={on === true} disabled={busy || on === null} onChange={(e) => void toggle(e.target.checked)} aria-label="تنبيهات باشت" /></label></div>
  );
}
