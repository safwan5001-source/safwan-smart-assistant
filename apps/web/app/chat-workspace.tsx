"use client";
import { useEffect, useRef, useState } from "react";
type SpeechResult={isFinal:boolean;0:{transcript:string}};
type SpeechEngine={lang:string;continuous:boolean;interimResults:boolean;onresult:((e:{resultIndex:number;results:ArrayLike<SpeechResult>})=>void)|null;onerror:((e:{error:string})=>void)|null;onend:(()=>void)|null;start:()=>void;stop:()=>void;abort:()=>void};
type SpeechWindow=Window&{SpeechRecognition?:new()=>SpeechEngine;webkitSpeechRecognition?:new()=>SpeechEngine};
type Attachment={id:string;name:string};
type Message={id:string;text:string;created:number;attachments?:Attachment[]};
type Thread={id:string;title:string;created:number;messages:Message[];archived?:boolean};
const KEY="safwan-local-chats-v1";
const makeThread=():Thread=>({id:crypto.randomUUID(),title:"محادثة جديدة",created:Date.now(),messages:[]});
export default function ChatWorkspace(){
 const [threads,setThreads]=useState<Thread[]>([]);
 const [selected,setSelected]=useState("");
 const [drawer,setDrawer]=useState(false);
 const [search,setSearch]=useState("");
 const [draft,setDraft]=useState("");
 const [attachments,setAttachments]=useState<Attachment[]>([]);
 const [fileError,setFileError]=useState("");
 const [fileBusy,setFileBusy]=useState(false);
 const picker=useRef<HTMLInputElement>(null);
 const [ready,setReady]=useState(false);
 const [archived,setArchived]=useState(false);
 const recognition=useRef<SpeechEngine|null>(null);
 const [listening,setListening]=useState(false);
 const [speechError,setSpeechError]=useState("");
 const [speechSupported,setSpeechSupported]=useState(false);
 useEffect(()=>{const w=window as SpeechWindow;setSpeechSupported(Boolean(w.SpeechRecognition||w.webkitSpeechRecognition));return()=>recognition.current?.abort()},[]);
 const toggleSpeech=()=>{
  if(listening){recognition.current?.stop();setListening(false);return}
  const w=window as SpeechWindow,Engine=w.SpeechRecognition||w.webkitSpeechRecognition;
  if(!Engine){setSpeechError("التعرف الصوتي غير متاح في هذا المتصفح.");return}
  recognition.current?.abort();const engine=new Engine();recognition.current=engine;
  engine.lang="ar-SA";engine.continuous=false;engine.interimResults=true;
  const original=draft;let committed="";
  engine.onresult=e=>{let interim="";for(let i=0;i<e.results.length;i++){const result=e.results[i];if(result.isFinal)committed+=result[0].transcript+" ";else interim+=result[0].transcript}setDraft([original,committed.trim(),interim.trim()].filter(Boolean).join(" "))};
  engine.onerror=e=>{setSpeechError(e.error==="not-allowed"||e.error==="service-not-allowed"?"تعذّر استخدام التعرف الصوتي. راجع إذن الميكروفون أو جرّب إملاء لوحة مفاتيح الآيفون.":"خطأ التعرف الصوتي: "+e.error);setListening(false)};
  engine.onend=()=>setListening(false);
  try{setSpeechError("");engine.start();setListening(true)}catch{setSpeechError("تعذر بدء الاستماع.");setListening(false)}
 };
 useEffect(()=>{try{const raw=localStorage.getItem(KEY);const list=raw?JSON.parse(raw):[];if(Array.isArray(list)){const safe=list.filter(t=>t&&typeof t.id==="string"&&Array.isArray(t.messages));setThreads(safe);if(safe.length)setSelected(safe[0].id)}}catch{}setReady(true)},[]);
 useEffect(()=>{if(ready)localStorage.setItem(KEY,JSON.stringify(threads))},[threads,ready]);
 const saveAttachments=async (picked:FileList|null)=>{
   if(!picked||fileBusy)return;
   const chosen=Array.from(picked);
   if(chosen.some(file=>file.size>25*1024*1024)){setFileError("الحد الأقصى لكل ملف 25 ميجابايت.");return;}
   setFileBusy(true);setFileError("");
   try {
     const db=await new Promise<IDBDatabase>((resolve,reject)=>{
       const req=indexedDB.open("safwan-files-v1",1);
       req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains("files"))req.result.createObjectStore("files",{keyPath:"id"});};
       req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
     });
     try {
       const items=chosen.map(file=>({id:crypto.randomUUID(),name:file.name,size:file.size,type:file.type||"غير معروف",file}));
       await new Promise<void>((resolve,reject)=>{
         const tx=db.transaction("files","readwrite");
         items.forEach(item=>tx.objectStore("files").put(item));
         tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
       });
       setAttachments(old=>[...old,...items.map(({id,name})=>({id,name}))]);
     } finally {db.close();}
   } catch {setFileError("تعذر حفظ المرفق محلياً. راجع مساحة تخزين المتصفح.");}
   finally {setFileBusy(false);if(picker.current)picker.current.value="";}
 };
 const current=threads.find(t=>t.id===selected);
 const create=()=>{recognition.current?.abort();setListening(false);const t=makeThread();setThreads(old=>[t,...old]);setSelected(t.id);setDraft("");setAttachments([]);setDrawer(false);setArchived(false)};
 const open=(id:string)=>{recognition.current?.abort();setListening(false);setSelected(id);setDrawer(false);setDraft("");setAttachments([])};
 const send=()=>{const value=draft.trim();if(!value&&!attachments.length)return;const item:Message={id:crypto.randomUUID(),text:value,created:Date.now(),attachments:[...attachments]};if(!current){const t=makeThread();t.title=(value||attachments[0]?.name||"مرفقات").slice(0,48);t.messages=[item];setThreads(old=>[t,...old]);setSelected(t.id)}else{setThreads(old=>old.map(t=>t.id===selected?{...t,title:t.messages.length?t.title:(value||attachments[0]?.name||"مرفقات").slice(0,48),messages:[...t.messages,item]}:t))}setDraft("");setAttachments([])};
 const rename=(id:string)=>{const t=threads.find(x=>x.id===id);if(!t)return;const title=window.prompt("اسم المحادثة",t.title);if(title?.trim())setThreads(old=>old.map(x=>x.id===id?{...x,title:title.trim().slice(0,80)}:x))};
 const archive=(id:string)=>setThreads(old=>old.map(t=>t.id===id?{...t,archived:!t.archived}:t));
 const remove=(id:string)=>{if(!window.confirm("حذف هذه المحادثة نهائياً من هذا الجهاز؟"))return;const next=threads.filter(t=>t.id!==id);setThreads(next);if(selected===id)setSelected(next[0]?.id||"")};
 const results=threads.filter(t=>Boolean(t.archived)===archived&&(t.title+" "+t.messages.map(m=>m.text).join(" ")).includes(search)).sort((a,b)=>b.created-a.created);
 return <div dir="rtl" style={{display:"flex",height:"min(70dvh,780px)",minHeight:470,border:"1px solid #9994",borderRadius:18,overflow:"hidden",position:"relative",background:"var(--surface,transparent)"}}>
   {drawer&&<button aria-label="إغلاق القائمة" onClick={()=>setDrawer(false)} style={{position:"absolute",inset:0,background:"#0007",border:0,zIndex:3}}/>}
   <aside style={{width:drawer?260:0,overflow:"hidden",flexShrink:0,position:drawer?"absolute":"relative",right:0,top:0,bottom:0,zIndex:4,background:"var(--bg,#f9f9f9)",color:"var(--fg,inherit)",borderLeft:drawer?"1px solid #9995":"none",transition:"width .15s"}}>
    <div style={{padding:12,display:"grid",gap:9,width:260,boxSizing:"border-box"}}>
     <button onClick={create} style={{padding:12,borderRadius:12}}>＋ محادثة جديدة</button>
     <input aria-label="البحث في الدردشات" placeholder="البحث في الدردشات" value={search} onChange={e=>setSearch(e.target.value)} style={{padding:10,borderRadius:10,width:"100%",boxSizing:"border-box"}}/>
     <div style={{display:"flex",gap:8}}><button onClick={()=>setArchived(false)} aria-pressed={!archived}>الدردشات</button><button onClick={()=>setArchived(true)} aria-pressed={archived}>الأرشيف</button></div>
     <div style={{display:"grid",gap:8,overflowY:"auto",maxHeight:"48dvh"}}>
      {results.map(t=><div key={t.id} style={{border:"1px solid #9995",borderRadius:12,padding:8}}>
        <button onClick={()=>open(t.id)} aria-current={selected===t.id?"page":undefined} style={{textAlign:"right",width:"100%",padding:7,fontWeight:selected===t.id?700:400,overflowWrap:"anywhere"}}>{t.title}</button>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",fontSize:11}}><button onClick={()=>rename(t.id)} aria-label={"إعادة تسمية "+t.title}>تسمية</button><button onClick={()=>archive(t.id)}>{t.archived?"استعادة":"أرشفة"}</button><button onClick={()=>remove(t.id)}>حذف</button></div>
       </div>)}
      {!results.length&&<small>لا توجد محادثات هنا.</small>}
     </div>
    </div>
   </aside>
   <div style={{display:"flex",flex:1,flexDirection:"column",minWidth:0}}>
     <div style={{padding:12,display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid #9994"}}>
       <button onClick={()=>setDrawer(x=>!x)} aria-label="فتح قائمة الدردشات" aria-expanded={drawer}>☰ الدردشات</button>
       <strong style={{flex:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{current?.title||"محادثة جديدة"}</strong>
       <button onClick={create} aria-label="محادثة جديدة">＋</button>
     </div>
     <div aria-live="polite" style={{flex:1,overflowY:"auto",padding:16,display:"flex",flexDirection:"column",gap:12}}>
      {(!current||!current.messages.length)&&<div style={{margin:"auto",textAlign:"center"}}><h2>كيف أستطيع مساعدتك؟</h2><p>اكتب رسالة لتجربة واجهة الدردشة.</p></div>}
      {current?.messages.map(m=><div key={m.id} style={{alignSelf:"flex-start",maxWidth:"92%",background:"#64748b20",borderRadius:15,padding:"10px 14px",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{m.text}{m.attachments?.map(a=><div key={a.id} style={{fontSize:12,marginTop:6}}>📎 {a.name}</div>)}</div>)}
     </div>
     <div style={{padding:12,borderTop:"1px solid #9994",display:"grid",gap:9}}>
      <input ref={picker} type="file" multiple aria-label="إضافة مرفقات من الجهاز" style={{display:"none"}} onChange={e=>void saveAttachments(e.target.files)}/>
      {attachments.length>0&&<div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{attachments.map(a=><span key={a.id} style={{padding:"6px 9px",border:"1px solid var(--border)",borderRadius:10,fontSize:12}}>📎 {a.name} <button type="button" aria-label={"إزالة المرفق "+a.name} onClick={()=>setAttachments(old=>old.filter(x=>x.id!==a.id))}>×</button></span>)}</div>}
      <div style={{display:"flex",gap:8,alignItems:"end"}}>
       <textarea aria-label="اكتب رسالة" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}}} rows={2} placeholder="اكتب رسالتك هنا..." style={{flex:1,minWidth:0,resize:"vertical",borderRadius:12,padding:12,background:"transparent",color:"inherit"}}/>
       <button type="button" className="composer-icon-button" disabled={fileBusy} onClick={()=>picker.current?.click()} aria-label="إرفاق ملف" title="إرفاق ملف">＋</button>
       <button type="button" onClick={toggleSpeech} disabled={!speechSupported} aria-label={listening?"إيقاف الإملاء الصوتي":"بدء الإملاء الصوتي"} aria-pressed={listening} title={speechSupported?"إملاء عربي":"التعرف الصوتي غير مدعوم"} className={"composer-icon-button "+(listening?"is-listening":"")}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 10.5a6.5 6.5 0 0 0 13 0M12 17v4m-4 0h8"/></svg></button>
       <button onClick={send} disabled={!draft.trim()&&!attachments.length} className="composer-send" aria-label="إرسال الرسالة"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 12 15-8-4 16-3-7-8-1Zm8 1 7-9"/></svg></button>
      </div>
      {listening&&<small role="status" className="speech-status">يستمع الآن… تحدّث بالعربية، ثم راجع النص قبل الإرسال.</small>}
      {fileError&&<small role="alert" className="speech-error">{fileError}</small>}
      {speechError&&<small role="alert" className="speech-error">{speechError}</small>}
      <small style={{opacity:.75}}>الرسائل تُحفظ محلياً على هذا الجهاز فقط. المرفقات تحفظ في مكتبة الملفات المحلية على هذا الجهاز، ولا تُرسل للخادم أو إلى ذكاء اصطناعي. لا توجد مزامنة أو تشفير حساب حتى الآن. لا تكتب بيانات حساسة.</small>
     </div>
   </div>
  </div>
}
