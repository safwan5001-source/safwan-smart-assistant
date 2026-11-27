import "server-only";
import { readNotifyConfig, type NotifyConfig } from "./config";
import { createMemoryStore } from "./memory-store";
import { createPgStore } from "./pg-store";
import { createWebPushSender, type PushSender } from "./push";
import { dispatchTick } from "./dispatch";
import { apiFeed, pollBashtEvents, type BashtReport, type Feed } from "./basht-events";
import { callBackend } from "../backend";
import type { NotifyStore } from "./types";

export type StoreKind = "postgres" | "memory" | "none";
export type Runtime = {
  cfg: NotifyConfig; store: NotifyStore | null; storeKind: StoreKind; send: PushSender | null; now: () => number;
  /** B4: the BASHT event feed (through the API); polled once per dispatcher tick */
  bashtFeed: Feed | null;
};

export function buildRuntime(cfg: NotifyConfig = readNotifyConfig(), over: Partial<Pick<Runtime, "store" | "send" | "now" | "bashtFeed">> = {}): Runtime {
  let store: NotifyStore | null = over.store ?? null;
  let storeKind: StoreKind = over.store ? "memory" : "none";
  if (!store && cfg.databaseUrl) { store = createPgStore(cfg.databaseUrl); storeKind = "postgres"; }
  else if (!store && cfg.allowMemory) { store = createMemoryStore(); storeKind = "memory"; }
  const send = over.send ?? (cfg.push ? createWebPushSender(cfg.push) : null);
  const bashtFeed = over.bashtFeed !== undefined ? over.bashtFeed : apiFeed((o) => callBackend(o));
  return { cfg, store, storeKind, send, now: over.now ?? Date.now, bashtFeed };
}
/** Push is usable only when keys AND a store are configured. */
export const isReady = (rt: Runtime) => !!rt.cfg.push && !!rt.store && !!rt.send;

let singleton: Runtime | null = null;
export const getRuntime = (): Runtime => (singleton ??= buildRuntime());
export const setRuntimeForTests = (rt: Runtime | null) => { singleton = rt; };

/** B4: one poll of the BASHT feed under the dispatcher lock (null: another instance holds it, or no feed). Never throws. */
export async function pollBasht(rt: Runtime): Promise<BashtReport | null> {
  if (!isReady(rt) || !rt.bashtFeed) return null;
  try { return await rt.store!.withLock(() => pollBashtEvents(rt.store!, rt.bashtFeed!, rt.now())); }
  catch { return null; }
}

let loop: ReturnType<typeof setInterval> | null = null;
/** Starts the in-process dispatcher (long-running Node server, e.g. Railway). Serverless hosts use POST /api/notify/dispatch instead. */
export function startDispatchLoop(rt: Runtime = getRuntime(), log: (m: string) => void = (m) => console.log(m)): boolean {
  if (loop || !isReady(rt) || !rt.cfg.loop) return false;
  const tick = async () => {
    try {
      const b = await pollBasht(rt); // first, so a new BASHT alert goes out in this same tick
      if (b?.queued || b?.cancelled) log(`[notify] basht ${JSON.stringify(b)}`);
      const r = await dispatchTick(rt.store!, rt.send!, rt.now());
      if (r.fired || r.sent || r.failed || r.gone || r.retried) log(`[notify] tick ${JSON.stringify(r)}`);
    } catch (e) { log(`[notify] tick failed: ${(e as Error).name}`); }
  };
  loop = setInterval(tick, rt.cfg.tickMs);
  loop.unref?.();
  void tick();
  log(`[notify] dispatcher started (store=${rt.storeKind}, every ${rt.cfg.tickMs}ms)`);
  return true;
}
export function stopDispatchLoop() { if (loop) clearInterval(loop); loop = null; }
