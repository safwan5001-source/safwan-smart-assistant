"use client";
import { useEffect, useRef, useState } from "react";

type LocalFile = { id: string; name: string; size: number; type: string; file: File };
const DB_NAME = "safwan-files-v1", STORE = "files";
const readableSize = (size: number) => size < 1024 ? size+" B" : size < 1048576 ? (size/1024).toFixed(1)+" KB" : (size/1048576).toFixed(1)+" MB";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    if (!("indexedDB" in window)) { reject(new Error("unsupported")); return; }
    const req = indexedDB.open(DB_NAME,1);
    req.onupgradeneeded = ()=>{ if(!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE,{keyPath:"id"}); };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
    req.onblocked = ()=>reject(new Error("blocked"));
  });
}
async function readFiles(): Promise<LocalFile[]> {
  const db = await openDb();
  try {
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,"readonly");
      const req=tx.objectStore(STORE).getAll();
      req.onsuccess=()=>resolve((req.result as LocalFile[]).filter(f=>f && typeof f.id==="string" && f.file instanceof Blob));
      req.onerror=()=>reject(req.error);
      tx.onabort=()=>reject(tx.error);
    });
  } finally {db.close();}
}
async function saveFiles(items:LocalFile[]): Promise<void> {
  const db=await openDb();
  try {
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction(STORE,"readwrite");
      const store=tx.objectStore(STORE);
      items.forEach(item=>store.put(item));
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error);
    });
  } finally {db.close();}
}
async function deleteFile(id:string): Promise<void> {
  const db=await openDb();
  try {
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction(STORE,"readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error);
    });
  } finally {db.close();}
}
export default function FilesWorkspace() {
  const [files,setFiles]=useState<LocalFile[]>([]);
  const [query,setQuery]=useState("");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const chooser=useRef<HTMLInputElement>(null);
  useEffect(()=>{
    let active=true;
    readFiles().then(items=>{if(active)setFiles(items);})
      .catch(()=>{if(active)setError("تعذر فتح التخزين المحلي في هذا المتصفح. لا يمكن ضمان حفظ الملفات.");})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[]);
  const add=async (list:FileList|null)=>{
    if(!list||busy||loading)return;
    const chosen=Array.from(list);
    if(chosen.some(f=>f.size>25*1024*1024)){setError("الحد الأقصى لكل ملف 25 ميجابايت.");return;}
    const items=chosen.map(f=>({id:crypto.randomUUID(),name:f.name,size:f.size,type:f.type||"غير معروف",file:f}));
    setBusy(true);setError("");
    try {await saveFiles(items);setFiles(old=>[...items,...old]);}
    catch {setError("تعذر حفظ الملفات. قد تكون مساحة تخزين المتصفح ممتلئة أو التخزين مقيداً.");}
    finally {setBusy(false);if(chooser.current)chooser.current.value="";}
  };
  const remove=async(id:string)=>{
    setBusy(true);setError("");
    try {await deleteFile(id);setFiles(old=>old.filter(x=>x.id!==id));}
    catch {setError("تعذرت إزالة الملف من التخزين المحلي.");}
    finally {setBusy(false);}
  };
  const download=(item:LocalFile)=>{
    const url=URL.createObjectURL(item.file);
    const link=document.createElement("a");link.href=url;link.download=item.name;
    document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  };
  const shown=files.filter(f=>f.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="setting-card" aria-label="ملفات الجهاز" style={{display:"grid",gap:16}}>
    <div><h2>ملفاتي المحلية</h2><p>الملفات تُحفظ في مساحة التخزين الخاصة بهذا الموقع على هذا الجهاز، وتبقى عند التنقل وإعادة فتح الصفحة ما دام المتصفح يحتفظ ببياناته. لا يوجد رفع للخادم أو مزامنة أو نسخة احتياطية؛ قد تختفي الملفات إذا حُذفت بيانات الموقع أو أزال المتصفح التخزين.</p></div>
    <input ref={chooser} type="file" multiple disabled={busy||loading} aria-label="اختيار ملفات من الجهاز" onChange={e=>void add(e.target.files)} style={{maxWidth:"100%"}}/>
    <input value={query} onChange={e=>setQuery(e.target.value)} aria-label="البحث في الملفات المحفوظة" placeholder="البحث في الملفات" style={{padding:12,borderRadius:12,border:"1px solid var(--border)",background:"var(--surface-alt)",color:"var(--text)",minWidth:0}}/>
    {error&&<p role="alert">{error}</p>}
    <p role="status" style={{margin:0}}>{loading?"جارٍ قراءة الملفات…":busy?"جارٍ حفظ التغييرات…":files.length+" ملف محفوظ محلياً"}</p>
    {!loading&&!shown.length&&<p>لا توجد ملفات مطابقة. اختر ملفاً للبدء.</p>}
    <ul style={{margin:0,padding:0,listStyle:"none",display:"grid",gap:10}}>
      {shown.map(f=><li key={f.id} style={{border:"1px solid var(--border)",borderRadius:12,padding:12,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <span style={{flex:"1 1 150px",minWidth:0,overflowWrap:"anywhere"}}><strong>{f.name}</strong><small style={{display:"block",color:"var(--muted)",marginTop:4}}>{readableSize(f.size)} · {f.type}</small></span>
        <button className="secondary-button" onClick={()=>download(f)} aria-label={"تنزيل "+f.name}>تنزيل</button>
        <button className="secondary-button" disabled={busy} onClick={()=>void remove(f.id)} aria-label={"إزالة "+f.name}>إزالة</button>
      </li>)}
    </ul>
  </section>;
}
