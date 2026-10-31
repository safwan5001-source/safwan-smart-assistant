/** Minimal browser-ish globals so lib/* can be tested in node. */
export function installBrowser(opts: { blockedStorage?: boolean } = {}) {
  const data = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => { if (opts.blockedStorage) throw new Error("blocked"); return data.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (opts.blockedStorage) throw new Error("blocked"); data.set(k, v); },
    removeItem: (k: string) => void data.delete(k),
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage, addEventListener() {}, removeEventListener() {} };
  return { data };
}
