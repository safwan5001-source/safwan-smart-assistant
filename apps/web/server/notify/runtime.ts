import "server-only";
import { readNotifyConfig, type NotifyConfig } from "./config";
import { createMemoryStore } from "./memory-store";
import { createPgStore } from "./pg-store";
import { createWebPushSender, type PushSender } from "./push";
import { dispatchTick } from "./dispatch";
import type { NotifyStore } from "./types";

export type StoreKind = "postgres" | "memory" | "none";
export type Runtime = {
  cfg: NotifyConfig; store: NotifyStore | null; storeKind: StoreKind; send: PushSender | null; now: () => number;
};

export function buildRuntime(cfg: NotifyConfig = readNotifyConfig(), over: Partial<Pick<Runtime, "store" | "send" | "now">> = {}): Runtime {
  let store: NotifyStore | null = over.store ?? null;
  let storeKind: StoreKind = over.store ? "memory" : "none";
  if (!store && cfg.databaseUrl) { store = createPgStore(cfg.databaseUrl); storeKind = "postgres"; }
  else if (!store && cfg.allowMemory) { store = createMemoryStore(); storeKind = "memory"; }
  const send = over.send ?? (cfg.push ? createWebPushSender(cfg.push) : null);
  return { cfg, store, storeKind, send, now: over.now ?? Date.now };
}
/** Push is usable only when keys AND a store are configured. */
export const isReady = (rt: Runtime) => !!rt.cfg.push && !!rt.store && !!rt.send;

let singleton: Runtime | null = null;
export const getRuntime = (): Runtime => (singleton ??= buildRuntime());
export const setRuntimeForTests = (rt: Runtime | null) => { singleton = rt; };

let loop: ReturnType<typeof setInterval> | null = null;
/** Starts the in-process dispatcher (long-running Node server, e.g. Railway). Serverless hosts use POST /api/notify/dispatch instead. */
export function startDispatchLoop(rt: Runtime = getRuntime(), log: (m: string) => void = (m) => console.log(m)): boolean {
  if (loop || !isReady(rt) || !rt.cfg.loop) return false;
  const tick = async () => {
    try {
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
