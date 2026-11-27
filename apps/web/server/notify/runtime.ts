import "server-only";
import { readNotifyConfig, type NotifyConfig } from "./config";
import { createMemoryStore } from "./memory-store";
import { createPgStore } from "./pg-store";
import { createWebPushSender, type PushSender } from "./push";
import { dispatchTick } from "./dispatch";
import type { NotifyStore } from "./types";
import { callBackend } from "../backend";
import { checkOwnerSession, ownerAuthOn } from "../owner-session";

export type StoreKind = "postgres" | "memory" | "none";
/** May this request register a new device? "ok" while unified sign-in (OWNER_AUTH) is off, else only with a valid owner session. */
export type OwnerGate = (req: Request) => Promise<"ok" | "unauthorized" | "unavailable">;
export type Runtime = {
  cfg: NotifyConfig; store: NotifyStore | null; storeKind: StoreKind; send: PushSender | null; now: () => number; ownerGate: OwnerGate;
};

/** Security review M4: with the login gate on, device registration is behind the same owner session as every other door. */
export const sessionOwnerGate = (env: Record<string, string | undefined> = process.env, call: typeof callBackend = callBackend): OwnerGate => async (req) => {
  if (!ownerAuthOn(env)) return "ok";
  const { account, outage } = await checkOwnerSession(req, { env, callBackend: call, now: Date.now });
  return account ? "ok" : outage ? "unavailable" : "unauthorized";
};

export function buildRuntime(cfg: NotifyConfig = readNotifyConfig(), over: Partial<Pick<Runtime, "store" | "send" | "now" | "ownerGate">> = {}): Runtime {
  let store: NotifyStore | null = over.store ?? null;
  let storeKind: StoreKind = over.store ? "memory" : "none";
  if (!store && cfg.databaseUrl) { store = createPgStore(cfg.databaseUrl); storeKind = "postgres"; }
  else if (!store && cfg.allowMemory) { store = createMemoryStore(); storeKind = "memory"; }
  const send = over.send ?? (cfg.push ? createWebPushSender(cfg.push) : null);
  return { cfg, store, storeKind, send, now: over.now ?? Date.now, ownerGate: over.ownerGate ?? sessionOwnerGate() };
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
