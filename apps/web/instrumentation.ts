/** Starts the push dispatcher inside the long-running Node server (Railway). No-op unless VAPID keys and a store are configured. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startDispatchLoop } = await import("./server/notify/runtime");
  startDispatchLoop();
}
