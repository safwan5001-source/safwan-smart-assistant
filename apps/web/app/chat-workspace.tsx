"use client";
import { useEffect, useState } from "react";
type Message={id:string;text:string;created:number};
type Thread={id:string;title:string;created:number;messages:Message[];archived?:boolean};
const KEY="safwan-local-chats-v1";
const makeThread=():Thread=>({id:crypto.randomUUID(),title:"محادثة جديدة",created:Date.now(),messages:[]});
export default function ChatWorkspace(){
 const [threads,setThreads]=useState<Thread[]>([]);
 const [selected,setSelected]=useState("");
 const [drawer,setDrawer]=useState(false);
 const [search,setSearch]=useState("");
 const [draft,setDraft]=useState("");
 const [ready,setReady]=useState(false);
 const [archived,setArchived]=useState(false);
 useEffect(()=>{try{const raw=localStorage.getItem(KEY);const list=raw?JSON.parse(raw):[];if(Array.isArray(list)){const safe=list.filter(t=>t&&typeof t.id==="string"&&Array.isArray(t.messages));setThreads(safe);if(safe.length)setSelected(safe[0].id)}}catch{}setReady(true)},[]);
 useEffect(()=>{if(ready)localStorage.setItem(KEY,JSON.stringify(threads))},[threads,ready]);
 const current=threads.find(t=>t.id===selected);
 const create=()=>{const t=makeThread();setThreads(old=>[t,...old]);setSelected(t.id);setDraft("");setDrawer(false);setArchived(false)};
 const open=(id:string)=>{setSelected(id);setDrawer(false);setDraft("")};
 const send=()=>{const value=draft.trim();if(!value)return;const item:Message={id:crypto.randomUUID(),text:value,created:Date.now()};if(!current){const t=makeThread();t.title=value.slice(0,48);t.messages=[item];setThreads(old=>[t,...old]);setSelected(t.id)}else{setThreads(old=>old.map(t=>t.id===selected?{...t,title:t.messages.length?t.title:value.slice(0,48),messages:[...t.messages,item]}:t))}setDraft("")};
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
      {current?.messages.map(m=><div key={m.id} style={{alignSelf:"flex-start",maxWidth:"92%",background:"#64748b20",borderRadius:15,padding:"10px 14px",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{m.text}</div>)}
     </div>
     <div style={{padding:12,borderTop:"1px solid #9994",display:"grid",gap:9}}>
      <div style={{display:"flex",gap:8,alignItems:"end"}}>
       <textarea aria-label="اكتب رسالة" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}}} rows={2} placeholder="اكتب رسالتك هنا..." style={{flex:1,minWidth:0,resize:"vertical",borderRadius:12,padding:12,background:"transparent",color:"inherit"}}/>
       <button onClick={send} disabled={!draft.trim()} style={{padding:12,borderRadius:12}}>إرسال</button>
      </div>
      <small style={{opacity:.75}}>الرسائل تُحفظ محلياً على هذا الجهاز فقط. لا يوجد رد ذكاء اصطناعي أو مزامنة أو تشفير حساب حتى الآن. لا تكتب بيانات حساسة.</small>
     </div>
   </div>
  </div>
}
