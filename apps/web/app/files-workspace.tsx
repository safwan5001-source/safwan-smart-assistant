"use client";
import { useRef, useState } from "react";

type LocalFile = { id: string; name: string; size: number; type: string; file: File };
const readableSize = (size: number) => size < 1024 ? size + " B" : size < 1048576 ? (size/1024).toFixed(1)+" KB" : (size/1048576).toFixed(1)+" MB";
export default function FilesWorkspace() {
  const [files,setFiles]=useState<LocalFile[]>([]);
  const [query,setQuery]=useState("");
  const [error,setError]=useState("");
  const chooser=useRef<HTMLInputElement>(null);
  const add=(list:FileList|null)=>{
    if(!list)return;
    const chosen=Array.from(list);
    if(chosen.some(f=>f.size>25*1024*1024)){setError("الحد الأقصى لكل ملف 25 ميجابايت.");return;}
    setError("");
    setFiles(old=>[...chosen.map(f=>({id:crypto.randomUUID(),name:f.name,size:f.size,type:f.type||"غير معروف",file:f})),...old].slice(0,100));
    if(chooser.current)chooser.current.value="";
  };
  const preview=(item:LocalFile)=>{
    const url=URL.createObjectURL(item.file);
    const link=document.createElement("a");
    link.href=url;link.download=item.name;
    link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
  };
  const shown=files.filter(f=>f.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="setting-card" aria-label="ملفات الجهاز" style={{display:"grid",gap:16}}>
    <div><h2>ملفاتي المحلية</h2><p>اختر ملفات من جهازك لعرضها في القائمة وتنزيل نسخة منها. الملفات لا تُرسل إلى خادم ولا تُحفظ في الحساب. تختفي القائمة عند إعادة تحميل الصفحة.</p></div>
    <input ref={chooser} type="file" multiple aria-label="اختيار ملفات من الجهاز" onChange={e=>add(e.target.files)} style={{maxWidth:"100%"}}/>
    <input value={query} onChange={e=>setQuery(e.target.value)} aria-label="البحث في الملفات المختارة" placeholder="البحث في الملفات المختارة" style={{padding:12,borderRadius:12,border:"1px solid var(--border)",background:"var(--surface-alt)",color:"var(--text)",minWidth:0}}/>
    {error&&<p role="alert">{error}</p>}
    <p role="status" style={{margin:0}}>{files.length} ملف في هذه الجلسة</p>
    {!shown.length&&<p>لا توجد ملفات مطابقة. اختر ملفاً للبدء.</p>}
    <ul style={{margin:0,padding:0,listStyle:"none",display:"grid",gap:10}}>
      {shown.map(f=><li key={f.id} style={{border:"1px solid var(--border)",borderRadius:12,padding:12,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <span style={{flex:"1 1 150px",minWidth:0,overflowWrap:"anywhere"}}><strong>{f.name}</strong><small style={{display:"block",color:"var(--muted)",marginTop:4}}>{readableSize(f.size)} · {f.type}</small></span>
        <button className="secondary-button" onClick={()=>preview(f)} aria-label={"تنزيل "+f.name}>تنزيل</button>
        <button className="secondary-button" onClick={()=>setFiles(old=>old.filter(x=>x.id!==f.id))} aria-label={"إزالة "+f.name}>إزالة</button>
      </li>)}
    </ul>
  </section>;
}
