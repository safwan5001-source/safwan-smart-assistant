"use client";
/**
 * «الذاكرة» (B6): BASHT's memory, read-only. Index state from the engine, search over memory files (never conversation transcripts),
 * and a read-only viewer for MEMORY.md / USER.md and for the file of any search hit. Text is shown as plain text (no HTML).
 * Editing stays in the OpenClaw Control UI or in the chat with BASHT.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "@/components/icon";
import Modal from "@/components/modal";
import { Badge, Empty, ListSkeleton, Notice, PageHeader } from "@/components/ui";
import { bashtClient } from "@/lib/basht-client";
import { controlClient, controlErrorText, isUnavailable, latestOnly, MEMORY_STATE, type MemoryHit, type MemoryStatus, type MemoryText } from "@/lib/basht-control";
import { formatSize, formatTime } from "@/lib/format";

type Doc = { title: string; load: (part: number) => Promise<MemoryText & { exists?: boolean }> };
type Gate = "loading" | "off" | "unavailable" | "ready" | "error";

export default function MemoryScreen() {
  const [gate, setGate] = useState<Gate>("loading");
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState<{ q: string; page: number; hits: MemoryHit[]; more: boolean; stale: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [doc, setDoc] = useState<Doc | null>(null);

  const load = useCallback(async () => {
    const s = await bashtClient.status();
    if (!s.enabled || !s.authenticated) { setGate("off"); return; }
    try { setStatus(await controlClient.memoryStatus()); setGate("ready"); }
    catch (e) { setGate(isUnavailable(e) ? "unavailable" : "error"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // only the newest search (or page) may update the results: a slower, superseded answer is dropped
  const latest = useRef(latestOnly()).current;
  const run = async (text: string, page: number) => {
    const t = text.trim();
    if (!t) return;
    const token = latest.begin();
    setSearching(true); setSearchError("");
    try {
      const r = await controlClient.memorySearch(t, page);
      if (!latest.current(token)) return;
      setSearch((prev) => ({ q: t, page, hits: page > 0 && prev?.q === t ? [...prev.hits, ...r.results] : r.results, more: r.more, stale: r.stale }));
    } catch (e) { if (latest.current(token)) setSearchError(controlErrorText(e)); } finally { if (latest.current(token)) setSearching(false); }
  };

  const st = status ? MEMORY_STATE[status.state] ?? MEMORY_STATE.unknown : null;
  return (
    <div className="page">
      <PageHeader icon="archive" eyebrow="باشت" title="الذاكرة" description="ما يتذكره باشت من ملفات ذاكرته، للقراءة فقط. التعديل يتم في المحادثة مع باشت أو من واجهة OpenClaw." />
      {gate === "loading" && <ListSkeleton rows={2} h={90} />}
      {gate === "off" && <div className="card"><Empty icon="lock" title="باشت غير متصل">سجّل الدخول وفعّل محادثة باشت لعرض ذاكرته.</Empty></div>}
      {gate === "unavailable" && <Notice>عرض الذاكرة غير متاح في نسخة محرك باشت الحالية.</Notice>}
      {gate === "error" && <Notice tone="warn" role="alert">تعذّرت قراءة حالة الذاكرة الآن. <button className="btn btn-sm" onClick={() => { setGate("loading"); void load(); }}>إعادة المحاولة</button></Notice>}
      {gate === "ready" && status && st && <>
        <section className="card card-pad" aria-labelledby="mem-st-h">
          <div className="section-head"><h2 id="mem-st-h"><Icon name="archive" size={18} />حالة الذاكرة</h2><Badge tone={st.tone}>{st.label}</Badge></div>
          {st.hint && <p className="muted" style={{ fontSize: 13.5, marginBlockStart: 6 }}>{st.hint}</p>}
          <div style={{ marginBlockStart: 6 }}>
            <div className="status-line"><span><strong>ملفات الذاكرة المفهرسة</strong><small>{status.search_mode === "fts-only" ? "بحث بالكلمات" : status.search_mode === "hybrid" ? "بحث بالكلمات والمعنى" : "—"}</small></span>
              <bdi className="num">{status.files == null ? "—" : `${status.files} ملف${status.chunks != null ? ` · ${status.chunks} مقطع` : ""}`}</bdi></div>
            {status.last_indexed_at != null && <div className="status-line"><span><strong>آخر فهرسة</strong></span><bdi className="num" dir="ltr">{formatTime(status.last_indexed_at)}</bdi></div>}
            {status.bootstrap.map((f) => (
              <div key={f.name} className="status-line">
                <span><strong dir="ltr" style={{ textAlign: "end" }}>{f.name}</strong><small>{f.name === "MEMORY.md" ? "الذاكرة المنسّقة" : "ملف تفضيلاتك"}{f.exists && f.size != null ? ` · ${formatSize(f.size)}` : ""}{f.updated_at ? ` · ${formatTime(f.updated_at)}` : ""}</small></span>
                {f.exists ? <button className="btn btn-sm" onClick={() => setDoc({ title: f.name, load: (p) => controlClient.memoryFile(f.name as "MEMORY.md" | "USER.md", p) })}>عرض</button> : <Badge>غير موجود</Badge>}
              </div>
            ))}
          </div>
        </section>

        <section className="stack" aria-labelledby="mem-q-h">
          <h2 id="mem-q-h" className="eyebrow-title">ابحث في ذاكرة باشت</h2>
          <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); void run(q, 0); }}>
            <Icon name="search" size={18} />
            <input className="input" type="search" maxLength={200} aria-label="ابحث في ذاكرة باشت" placeholder="مثال: مورد الورق" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" />
          </form>
          <small className="muted">يبحث في ملفات الذاكرة فقط، لا في المحادثات.</small>
          {searchError && <Notice tone="warn" role="alert">{searchError}</Notice>}
          {searching && !search && <ListSkeleton rows={2} h={70} />}
          {search && (
            <div className="stack" aria-live="polite" style={{ gap: 8 }}>
              {search.stale && <Notice>قد لا تكون آخر التحديثات في الفهرس بعد؛ النتائج من آخر فهرسة.</Notice>}
              {search.hits.length === 0 ? <div className="card"><Empty icon="search" title="لا نتائج">{search.stale ? "الفهرس قيد التحديث؛ جرّب بعد قليل أو بكلمة أخرى." : "جرّب كلمة أخرى."}</Empty></div> : (
                <ul className="stack" style={{ gap: 8 }}>
                  {search.hits.map((h, i) => (
                    <li key={`${h.ref ?? h.file}-${i}`}>
                      <button className="card card-pad ctl-hit" disabled={!h.ref} onClick={() => h.ref && setDoc({ title: h.file, load: (p) => controlClient.memoryItem(h.ref!, p) })}>
                        <span className="row" style={{ gap: 6 }}><Icon name="doc" size={16} /><strong dir="ltr">{h.file}</strong>{h.date && <Badge>{h.date}</Badge>}</span>
                        <span className="ctl-snippet">{h.snippet}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {search.more && <button className="btn btn-sm" disabled={searching} onClick={() => void run(search.q, search.page + 1)}>نتائج أخرى</button>}
            </div>
          )}
        </section>
        <Notice>تعديل الذاكرة غير متاح في التطبيق. اطلب من باشت في <Link href="/chat">المحادثة</Link> أن يتذكر شيئًا أو ينساه، أو عدّل الملفات من واجهة OpenClaw.</Notice>
      </>}
      <DocViewer doc={doc} onClose={() => setDoc(null)} />
    </div>
  );
}

function DocViewer({ doc, onClose }: { doc: Doc | null; onClose: () => void }) {
  const [text, setText] = useState<(MemoryText & { exists?: boolean }) | null>(null);
  const [error, setError] = useState("");
  const gen = useRef(0);
  const read = useCallback(async (d: Doc, part: number) => {
    const my = ++gen.current;
    setError(""); setText(null);
    try { const t = await d.load(part); if (my === gen.current) setText(t); } catch (e) { if (my === gen.current) setError(controlErrorText(e)); }
  }, []);
  useEffect(() => { if (doc) void read(doc, 0); }, [doc, read]);
  return (
    <Modal open={!!doc} onClose={onClose} label={doc?.title ?? "ملف"}>
      {doc && (
        <div className="dialog-card ctl-doc">
          <div className="row"><h2 style={{ flex: 1 }} dir="ltr">{doc.title}</h2><Badge>للقراءة فقط</Badge><button className="icon-btn" onClick={onClose} aria-label="إغلاق"><Icon name="close" size={20} /></button></div>
          {error ? <Notice tone="warn" role="alert">{error}</Notice> : !text ? <ListSkeleton rows={3} h={18} /> : text.exists === false ? <p className="muted">هذا الملف غير موجود بعد.</p> : (
            <>
              <pre className="ctl-text" dir="auto">{text.text || "(فارغ)"}</pre>
              {text.parts > 1 && (
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <button className="btn btn-sm" disabled={text.part === 0} onClick={() => void read(doc, text.part - 1)}>السابق</button>
                  <small className="muted num">الجزء {text.part + 1} من {text.parts}</small>
                  <button className="btn btn-sm" disabled={text.part + 1 >= text.parts} onClick={() => void read(doc, text.part + 1)}>التالي</button>
                </div>
              )}
              {text.truncated && <small className="muted">الملف أطول مما يُعرض هنا؛ اقرأه كاملًا من واجهة OpenClaw.</small>}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
