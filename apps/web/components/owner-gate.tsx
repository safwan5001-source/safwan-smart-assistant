"use client";
/**
 * Login gate, client side: the server already refuses every page without a session (middleware.ts). This catches a session that
 * ends WHILE the app is open (expired, signed out elsewhere, "sign out everywhere"): it sends the owner to /login and back to the
 * same place afterwards. Checked on return to the app, on focus and every minute; any door that sees its session gone calls
 * `signInAgain()` at once. Does nothing while the gate is off (legacy per-door codes) or when the server cannot be asked.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { authClient } from "@/lib/owner-auth";
import { LOGIN_PATH, safeNext } from "@/lib/login-path";

type Gate = { on: boolean; signInAgain: () => void };
const GateContext = createContext<Gate>({ on: false, signInAgain: () => {} });
export const useOwnerGate = () => useContext(GateContext);

export function expiredLoginHref(current: string): string {
  const next = safeNext(current);
  return `${LOGIN_PATH}?${next !== "/" ? `next=${encodeURIComponent(next)}&` : ""}reason=expired`;
}

export function OwnerGateProvider({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(false);
  const signInAgain = useCallback(() => { window.location.assign(expiredLoginHref(window.location.pathname + window.location.search)); }, []);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const s = await authClient.status();
      if (!alive) return;
      setOn(s.gate && s.owner_auth);
      if (s.gate && s.owner_auth && !s.authenticated) signInAgain(); // only when the server SAID the session is gone
    };
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    void check();
    const t = window.setInterval(() => void check(), 60_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { alive = false; window.clearInterval(t); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [signInAgain]);

  return <GateContext.Provider value={{ on, signInAgain }}>{children}</GateContext.Provider>;
}
