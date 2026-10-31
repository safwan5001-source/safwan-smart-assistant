/**
 * Tiny external-store layer over localStorage, shaped for React's useSyncExternalStore.
 * - SSR-safe (server snapshot = fallback), cross-tab aware, never throws.
 * - If storage is blocked/full the value still lives in memory for the session and
 *   `getError()` reports that it will not persist.
 */
export type Store<T> = {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  getError: () => string | null;
  reset: () => void;
};

type Options<T> = { key: string; fallback: T; decode: (raw: string | null) => T; encode: (value: T) => string };

const memory = new Map<string, string>();

type Backend = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function backend(): { api: Backend; persistent: boolean } {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const probe = "__safwan_probe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      return { api: window.localStorage, persistent: true };
    }
  } catch {
    /* blocked (private mode, policy): fall through to memory */
  }
  return {
    persistent: false,
    api: {
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => void memory.set(k, v),
      removeItem: (k) => void memory.delete(k),
    },
  };
}

export function createStore<T>({ key, fallback, decode, encode }: Options<T>): Store<T> {
  const listeners = new Set<() => void>();
  let cachedRaw: string | null | undefined;
  let cachedValue: T = fallback;
  let error: string | null = null;
  let attached = false;
  // After a failed write (quota/blocked) the in-memory value is the truth: re-reading the stale
  // persisted value would silently discard the user's latest change. Cleared by the next successful write.
  let degraded = false;

  const notify = () => listeners.forEach((l) => l());
  const read = (): T => {
    if (typeof window === "undefined") return fallback;
    if (degraded) return cachedValue;
    let raw: string | null = null;
    try {
      raw = backend().api.getItem(key);
    } catch {
      raw = null;
    }
    if (raw === cachedRaw) return cachedValue;
    cachedRaw = raw;
    try {
      cachedValue = decode(raw);
    } catch {
      cachedValue = fallback;
    }
    return cachedValue;
  };

  const onStorage = (e: StorageEvent) => {
    if (e.key === key || e.key === null) notify();
  };

  return {
    subscribe(cb) {
      listeners.add(cb);
      if (!attached && typeof window !== "undefined") {
        window.addEventListener("storage", onStorage);
        attached = true;
      }
      return () => {
        listeners.delete(cb);
        if (!listeners.size && attached) {
          window.removeEventListener("storage", onStorage);
          attached = false;
        }
      };
    },
    getSnapshot: read,
    getServerSnapshot: () => fallback,
    set(next) {
      const value = typeof next === "function" ? (next as (p: T) => T)(read()) : next;
      const raw = encode(value);
      const NOT_SAVED = "تعذر الحفظ على هذا الجهاز؛ التغييرات ستبقى حتى إغلاق الصفحة فقط.";
      try {
        const b = backend();
        b.api.setItem(key, raw);
        error = b.persistent ? null : NOT_SAVED;
        degraded = !b.persistent;
      } catch {
        memory.set(key, raw);
        error = NOT_SAVED;
        degraded = true;
      }
      cachedRaw = raw;
      cachedValue = value;
      notify();
    },
    getError: () => error,
    reset() {
      try {
        backend().api.removeItem(key);
      } catch {
        /* ignore */
      }
      memory.delete(key);
      cachedRaw = undefined;
      error = null;
      degraded = false;
      notify();
    },
  };
}

/** JSON codec whose `parse` must always return a valid, sanitised value. */
export function jsonCodec<T>(parse: (value: unknown) => T, fallback: T) {
  return {
    decode: (raw: string | null): T => {
      if (!raw) return fallback;
      try {
        return parse(JSON.parse(raw));
      } catch {
        return fallback;
      }
    },
    encode: (value: T) => JSON.stringify(value),
  };
}
