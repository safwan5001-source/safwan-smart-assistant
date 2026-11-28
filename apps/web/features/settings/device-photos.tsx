"use client";
/**
 * «صور هذا الجهاز»: how many sent-photo copies this device keeps for the signed-in owner (and their size), what they are for, and
 * «مسح نسخ الصور على هذا الجهاز» (after a confirmation). It clears only the current owner's copies; the result is honest (lib/device-photos).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Icon from "@/components/icon";
import { Notice } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { formatSize } from "@/lib/format";
import { localAttachments } from "@/lib/local-attachments";
import { getOwnerScope, subscribeOwnerScope } from "@/lib/owner-scope";
import { clearDevicePhotos, DEVICE_PHOTOS_TEXT as T, readDevicePhotos, type DevicePhotosView } from "@/lib/device-photos";

/** The line under the title for a view (also used by the tests). */
export function devicePhotosLine(v: DevicePhotosView | null): string {
  if (!v) return "";
  if (v.status === "noowner") return T.noOwner;
  if (v.status === "unreadable") return T.unreadable;
  return v.count ? "" : T.none;
}

export type DevicePhotosResult = { ok: boolean; text: string } | null;

/** The section itself (presentational): the numbers, what the copies are for, the clear button, and the honest result. */
export function DevicePhotosPanel({ view, busy, result, onClear }: { view: DevicePhotosView | null; busy: boolean; result: DevicePhotosResult; onClear: () => void }) {
  const ready = view?.status === "ready";
  return (
    <section className="card card-pad stack" aria-labelledby="photos-h">
      <div>
        <h2 id="photos-h">{T.title}</h2>
        <p className="muted" style={{ fontSize: 14 }}>
          {ready && view!.count > 0 && <><bdi className="num" data-testid="device-photos-usage">{view!.count} رسالة بصور · {formatSize(view!.bytes)}</bdi> · </>}
          {devicePhotosLine(view)}
        </p>
        <p className="muted" style={{ fontSize: 14 }}>{T.explain}</p>
      </div>
      <div className="row-wrap">
        <button type="button" className="btn btn-danger device-photos-clear" disabled={busy || !ready || view!.count === 0} onClick={onClear} aria-busy={busy || undefined}>
          <Icon name="trash" size={18} />{T.button}
        </button>
      </div>
      {result && <Notice tone={result.ok ? "ok" : "warn"} role={result.ok ? "status" : "alert"}>{result.text}</Notice>}
    </section>
  );
}

export default function DevicePhotos() {
  const { confirm, toast } = useDialogs();
  const mgr = localAttachments();
  const owner = useSyncExternalStore(subscribeOwnerScope, getOwnerScope, () => null);
  const records = useSyncExternalStore(mgr.subscribe, mgr.getSnapshot, mgr.getSnapshot); // a photo sent while this is open changes the numbers
  const [view, setView] = useState<DevicePhotosView | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DevicePhotosResult>(null);
  const refresh = useCallback(async () => setView(await readDevicePhotos(mgr, owner !== null)), [mgr, owner]);
  useEffect(() => { let live = true; void readDevicePhotos(mgr, owner !== null).then((v) => { if (live) setView(v); }); return () => { live = false; }; }, [mgr, owner, records]);

  const clear = async () => {
    if (busy) return;
    setBusy(true); setResult(null);
    try {
      const out = await clearDevicePhotos({ mgr, ownerKnown: owner !== null,
        confirm: () => confirm({ title: T.confirmTitle, message: T.confirmMessage, confirmLabel: T.confirmLabel, tone: "danger" }) });
      if (out.cancelled) return;
      setView(out.view); setResult({ ok: out.cleared, text: out.message });
      toast(out.message, out.cleared ? "ok" : "error");
    } finally { setBusy(false); void refresh(); }
  };
  return <DevicePhotosPanel view={view} busy={busy} result={result} onClear={() => void clear()} />;
}
