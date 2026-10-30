"use client";
import { useEffect, useRef, useState } from "react";
type Result = { isFinal:boolean; 0:{transcript:string} };
type Rec = {lang:string; continuous:boolean; interimResults:boolean; onresult:((e:{resultIndex:number;results:ArrayLike<Result>})=>void)|null; onerror:((e:{error:string})=>void)|null; onend:(()=>void)|null; start:()=>void; stop:()=>void; abort:()=>void};
type Win = Window & {SpeechRecognition?:new()=>Rec;webkitSpeechRecognition?:new()=>Rec};
export default function VoicePanel(){
 const ref=useRef<Rec|null>(null);
 const [ok,setOk]=useState<boolean|null>(null),[active,setActive]=useState(false),[text,setText]=useState(""),[draft,setDraft]=useState(""),[error,setError]=useState("");
 useEffect(()=>{const w=window as Win;setOk(Boolean(w.SpeechRecognition||w.webkitSpeechRecognition));return()=>ref.current?.abort()},[]);
 const stop=()=>{ref.current?.stop();setActive(false)};
 const start=()=>{
  const w=window as Win, Engine=w.SpeechRecognition||w.webkitSpeechRecognition;
  if(!Engine){setError("المتصفح لا يدعم التعرف الصوتي. استخدم Safari محدثاً.");return}
  ref.current?.abort(); const r=new Engine();ref.current=r;r.lang="ar-SA";r.continuous=true;r.interimResults=true;
  r.onresult=e=>{let final="",partial="";for(let i=e.resultIndex;i<e.results.length;i++){const x=e.results[i];if(x.isFinal)final+=x[0].transcript+" ";else partial+=x[0].transcript}if(final)setText(t=>(t+" "+final).trim());setDraft(partial)};
  r.onerror=e=>{setError(e.error==="not-allowed"?"اسمح بالميكروفون في إعدادات Safari.":"خطأ الميكروفون: "+e.error);setActive(false)};
  r.onend=()=>{setActive(false);setDraft("")};
  try{setError("");r.start();setActive(true)}catch{setError("تعذر تشغيل الميكروفون");setActive(false)}
 };
 return <section dir="rtl" style={{display:"grid",gap:12,maxWidth:620,margin:"auto",textAlign:"right"}}>
  <div style={{display:"flex",gap:12,justifyContent:"center"}}>
   <button type="button" disabled={ok===false} onClick={active?stop:start} aria-pressed={active} style={{borderRadius:16,padding:12}}>{active?"■ إيقاف الاستماع":"🎙 بدء الاستماع"}</button>
   <button type="button" onClick={()=>{stop();setText("");setDraft("");setError("")}} style={{borderRadius:16,padding:12}}>مسح النص</button>
  </div>
  <p role="status">{active?"الميكروفون يعمل — تحدث بالعربية":ok===false?"التعرف الصوتي غير مدعوم هنا":"اختبار الميكروفون باللغة العربية"}</p>
  <div aria-label="نص الكلام" style={{padding:16,minHeight:72,border:"1px solid #9996",borderRadius:12,overflowWrap:"anywhere"}}>{text||draft?<>{text} {draft}</>:"سيظهر نص كلامك هنا."}</div>
  {error&&<p role="alert">{error}</p>}
  <small>اختبار تفريغ صوتي فقط: لا يوجد رد ذكي أو تنفيذ أوامر أو اتصال بخادم المساعد حتى الآن. قد يستخدم التعرف خدمة يوفرها المتصفح.</small>
 </section>
}