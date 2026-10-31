"use client";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon, { type IconName } from "@/components/icon";
import Modal from "@/components/modal";
import { Empty, ListSkeleton, Notice, PageHeader } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { deleteFile, downloadBlob, fileKind, listFiles, MAX_FILE_BYTES, putFiles, toLocalFiles, tooLarge, type LocalFile } from "@/lib/files-db";
import { formatSize, formatTime } from "@/lib/format";
import { matches } from "@/lib/search";

type Kind = "all" | "image" | "pdf" | "sheet" | "doc" | "other";
const KINDS: { id: Kind; label: string }[] = [{ id: "all", label: "الكل" }, { id: "pdf", label: "PDF" }, { id: "image", label: "صور" }, { id: "sheet", label: "جداول" }, { id: "doc", label: "مستندات" }, { id: "other", label: "أخرى" }];
const ICON: Record<Exclude<Kind, "all">, IconName> = { image: "image", pdf: "pdf", sheet: "sheet", doc: "doc", other: "file" };

export default function FilesScreen() {
  const { confirm, toast } = useDialogs();
  const params = useSearchParams();
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [kind, setKind] = useState<Kind>("all");
  const [over, setOver] = useState(false);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [preview, setPreview] = useState<{ name: string; url: string; kind: "image" | "pdf" } | null>(null);
  const chooser = useRef<HTMLInputElement>(null);

  const refreshUsage = useCallback(() => {
    navigator.storage?.estimate?.().then((e) => e.quota ? setUsage({ used: e.usage ?? 0, quota: e.quota }) : null).catch(() => undefined);
  }, []);
  useEffect(() => {
    let live = true;
    listFiles().then((f) => live && setFiles(f.sort((a, b) => (b.added ?? 0) - (a.added ?? 0))))
      .catch(() => live && setError("تعذر فتح التخزين المحلي في هذا المتصفح (وضع التصفح الخاص أو تخزين مقيّد). لا يمكن ضمان حفظ الملفات."))
      .finally(() => live && setLoading(false));
    refreshUsage();
    return () => { live = false; };
  }, [refreshUsage]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const add = async (list: FileList | File[] | null) => {
    const chosen = list ? Array.from(list) : [];
    if (!chosen.length || busy || loading) return;
    if (tooLarge(chosen)) { setError(`الحد الأقصى لكل ملف ${MAX_FILE_BYTES / 1048576} ميجابايت.`); return; }
    setBusy(true); setError("");
    try {
      const items = toLocalFiles(chosen);
      await putFiles(items);
      setFiles((old) => [...items, ...old]);
      toast(items.length === 1 ? "تم حفظ الملف" : `تم حفظ ${items.length} ملفات`); refreshUsage();
    } catch { setError("تعذر حفظ الملفات. قد تكون مساحة المتصفح ممتلئة أو التخزين مقيداً."); }
    finally { setBusy(false); if (chooser.current) chooser.current.value = ""; }
  };
  const remove = async (f: LocalFile) => {
    if (!(await confirm({ title: "إزالة الملف؟", message: `سيُحذف «${f.name}» من هذا الجهاز. المحادثات التي أرفقته لن تتمكن من فتحه.`, confirmLabel: "إزالة", tone: "danger" }))) return;
    setBusy(true);
    try { await deleteFile(f.id); setFiles((old) => old.filter((x) => x.id !== f.id)); toast("أُزيل الملف"); refreshUsage(); }
    catch { setError("تعذرت إزالة الملف من التخزين المحلي."); }
    finally { setBusy(false); }
  };
  const view = (f: LocalFile) => {
    const k = fileKind(f);
    if (k === "image" || k === "pdf") setPreview({ name: f.name, url: URL.createObjectURL(f.file), kind: k });
    else downloadBlob(f.file, f.name);
  };

  const counts = useMemo(() => {
    const c: Record<Kind, number> = { all: files.length, image: 0, pdf: 0, sheet: 0, doc: 0, other: 0 };
    files.forEach((f) => { c[fileKind(f)]++; });
    return c;
  }, [files]);
  const shown = files.filter((f) => (kind === "all" || fileKind(f) === kind) && matches(f.name, query));
  const pct = usage ? Math.max(1, Math.round((usage.used / usage.quota) * 100)) : 0;

  return (
    <div className="page">
      <PageHeader eyebrow="الملفات" title="ملفاتي" description="مكتبة محلية داخل هذا المتصفح. لا رفع للخادم ولا مزامنة ولا نسخ احتياطي؛ قد تختفي الملفات إذا حُذفت بيانات الموقع." />
      {error && <Notice tone="danger" role="alert">{error}</Notice>}

      <div className={"dropzone " + (over ? "over" : "")}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void add(e.dataTransfer.files); }}>
        <Icon name="download" size={28} style={{ transform: "rotate(180deg)" }} />
        <strong style={{ color: "var(--text)" }}>أضف ملفات إلى مكتبتك</strong>
        <small>PDF وصور وجداول ومستندات · حتى {MAX_FILE_BYTES / 1048576} ميجابايت للملف</small>
        <input ref={chooser} type="file" multiple hidden aria-label="اختيار ملفات من الجهاز" onChange={(e) => void add(e.target.files)} />
        <button className="btn btn-primary" disabled={busy || loading} onClick={() => chooser.current?.click()}>{busy ? <><span className="spinner" />جارٍ الحفظ…</> : <><Icon name="plus" size={18} />اختيار ملفات</>}</button>
      </div>

      <div className="stack">
        <div className="search"><Icon name="search" size={18} /><input className="input" type="search" aria-label="البحث في الملفات" placeholder="ابحث في الملفات" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div className="chips" role="group" aria-label="نوع الملف">
          {KINDS.filter((k) => k.id === "all" || counts[k.id] > 0 || kind === k.id).map((k) => (
            <button key={k.id} className="chip" aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>{k.label}<span className="count num">{counts[k.id]}</span></button>
          ))}
        </div>
      </div>

      <section aria-label="الملفات المحفوظة" aria-live="polite">
        {loading ? <ListSkeleton rows={3} h={68} /> : shown.length ? (
          <ul className="stack">
            {shown.map((f) => { const k = fileKind(f); return (
              <li key={f.id} className="file">
                <span className={"file-ico " + k}><Icon name={ICON[k]} size={22} /></span>
                <button style={{ flex: 1, minWidth: 0, textAlign: "start" }} onClick={() => view(f)} aria-label={"فتح " + f.name}>
                  <span className="name">{f.name}</span>
                  <small className="muted num">{formatSize(f.size)}{f.added ? " · " + formatTime(f.added) : ""}</small>
                </button>
                <button className="icon-btn sm" onClick={() => downloadBlob(f.file, f.name)} aria-label={"تنزيل " + f.name}><Icon name="download" size={18} /></button>
                <button className="icon-btn sm" disabled={busy} onClick={() => void remove(f)} aria-label={"إزالة " + f.name}><Icon name="trash" size={18} /></button>
              </li>); })}
          </ul>
        ) : <div className="card"><Empty icon="files" title={files.length ? "لا ملفات مطابقة" : "المكتبة فارغة"}>{files.length ? "غيّر التصفية أو عبارة البحث." : "اختر ملفاً للبدء. الملفات تبقى على جهازك."}</Empty></div>}
      </section>

      {usage && (
        <div className="card card-pad stack" aria-label="مساحة التخزين">
          <div className="row"><strong style={{ flex: 1 }}>مساحة التخزين التقديرية للموقع</strong><small className="muted num">{formatSize(usage.used)} من {formatSize(usage.quota)}</small></div>
          <div className="meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="نسبة المساحة المستخدمة"><i style={{ width: pct + "%" }} /></div>
        </div>
      )}

      <Modal open={!!preview} onClose={() => setPreview(null)} label={preview ? "معاينة " + preview.name : "معاينة"}>
        {preview && (
          <div className="dialog-card wide">
            <div className="row"><strong style={{ flex: 1, overflowWrap: "anywhere" }}>{preview.name}</strong><button className="icon-btn" onClick={() => setPreview(null)} aria-label="إغلاق المعاينة"><Icon name="close" size={20} /></button></div>
            {preview.kind === "image"
              // eslint-disable-next-line @next/next/no-img-element
              ? <img className="preview-img" src={preview.url} alt={preview.name} />
              : <iframe className="preview-frame" src={preview.url} title={preview.name} />}
            <a className="btn" href={preview.url} download={preview.name}><Icon name="download" size={18} />تنزيل</a>
          </div>
        )}
      </Modal>
    </div>
  );
}
