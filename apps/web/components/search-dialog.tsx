"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import Modal from "./modal";
import Icon, { type IconName } from "./icon";
import { NAV } from "@/lib/nav";
import { matches } from "@/lib/search";
import { listFiles } from "@/lib/files-db";
import { tasksStore, threadsStore } from "@/lib/stores";

type Result = { key: string; group: string; title: string; sub?: string; icon: IconName; href: string };
const LIMIT = 6;

export default function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [fileNames, setFileNames] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setQ(""); setActive(0);
    let live = true;
    listFiles().then((f) => live && setFileNames(f.map((x) => x.name))).catch(() => live && setFileNames([]));
    return () => { live = false; };
  }, [open]);

  const results = useMemo<Result[]>(() => {
    if (!open) return [];
    const out: Result[] = [];
    const pages = NAV.filter((n) => matches(n.label + " " + n.hint, q)).map((n) => ({ key: "p" + n.href, group: "الأقسام", title: n.label, sub: n.hint, icon: n.icon, href: n.href }));
    out.push(...(q ? pages.slice(0, LIMIT) : pages));
    if (!q.trim()) return out;
    out.push(...tasksStore.getSnapshot().filter((t) => matches(t.title + " " + (t.notes ?? ""), q)).slice(0, LIMIT)
      .map((t) => ({ key: "t" + t.id, group: "المهام", title: t.title, sub: t.done ? "مكتملة" : "قيد التنفيذ", icon: "tasks" as IconName, href: "/tasks?q=" + encodeURIComponent(t.title) })));
    out.push(...threadsStore.getSnapshot().filter((t) => matches(t.title + " " + t.messages.map((m) => m.text).join(" "), q)).slice(0, LIMIT)
      .map((t) => ({ key: "c" + t.id, group: "المحادثات", title: t.title, sub: t.messages.length + " رسالة", icon: "chat" as IconName, href: "/chat?t=" + t.id })));
    out.push(...fileNames.filter((n) => matches(n, q)).slice(0, LIMIT).map((n, i) => ({ key: "f" + i + n, group: "الملفات", title: n, icon: "file" as IconName, href: "/files?q=" + encodeURIComponent(n) })));
    return out;
  }, [open, q, fileNames]);

  useEffect(() => setActive(0), [q]);
  const go = (r: Result | undefined) => { if (!r) return; onClose(); router.push(r.href); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); go(results[active]); }
  };

  let lastGroup = "";
  return (
    <Modal open={open} onClose={onClose} label="بحث شامل" variant="top">
      <div className="dialog-card" style={{ width: "100%", padding: 14 }} onKeyDown={onKey}>
        <div className="search">
          <Icon name="search" size={20} />
          <input className="input" autoFocus type="search" enterKeyHint="search" placeholder="ابحث في المهام والمحادثات والملفات…" aria-label="بحث شامل"
            role="combobox" aria-expanded="true" aria-controls="search-results" aria-activedescendant={results[active] ? "sr-" + results[active].key : undefined}
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div id="search-results" role="listbox" aria-label="النتائج" style={{ maxHeight: "55dvh", overflowY: "auto" }}>
          {results.map((r, i) => {
            const header = r.group !== lastGroup ? <div className="search-group" role="presentation">{r.group}</div> : null;
            lastGroup = r.group;
            return (
              <div key={r.key} role="presentation">
                {header}
                <button id={"sr-" + r.key} role="option" aria-selected={i === active} className="search-result" onMouseEnter={() => setActive(i)} onClick={() => go(r)}>
                  <span className="file-ico" style={{ width: 36, height: 36 }}><Icon name={r.icon} size={18} /></span>
                  <span style={{ minWidth: 0 }}><strong style={{ display: "block", overflowWrap: "anywhere" }}>{r.title}</strong>{r.sub && <small className="muted">{r.sub}</small>}</span>
                </button>
              </div>
            );
          })}
          {q.trim() && !results.length && <div className="empty"><p>لا نتائج لـ «{q}».</p></div>}
        </div>
        <small className="muted">البحث يشمل بيانات هذا الجهاز فقط.<span className="kbd-hint"> <span className="kbd">Esc</span> للإغلاق</span></small>
      </div>
    </Modal>
  );
}
