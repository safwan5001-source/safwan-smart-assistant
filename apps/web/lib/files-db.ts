/** IndexedDB library for user files (same DB/store as earlier versions). Local to this browser only. */
export type LocalFile = { id: string; name: string; size: number; type: string; file: Blob; added?: number };
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DB_NAME = "safwan-files-v1";
const STORE = "files";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("unsupported"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest | null, result?: (req: IDBRequest | null) => T): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result ? result(req) : (undefined as T));
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const listFiles = () =>
  withStore<LocalFile[]>("readonly", (s) => s.getAll(), (r) =>
    ((r?.result ?? []) as LocalFile[]).filter((f) => f && typeof f.id === "string" && f.file instanceof Blob));
export const getFile = (id: string) => withStore<LocalFile | undefined>("readonly", (s) => s.get(id), (r) => r?.result as LocalFile | undefined);
export const putFiles = (items: LocalFile[]) => withStore<void>("readwrite", (s) => { items.forEach((i) => s.put(i)); return null; });
export const deleteFile = (id: string) => withStore<void>("readwrite", (s) => s.delete(id));
export const clearFiles = () => withStore<void>("readwrite", (s) => s.clear());

export const toLocalFiles = (list: File[]): LocalFile[] =>
  list.map((f) => ({ id: crypto.randomUUID(), name: f.name, size: f.size, type: f.type || "غير معروف", file: f, added: Date.now() }));
export const tooLarge = (list: File[]) => list.some((f) => f.size > MAX_FILE_BYTES);

export const fileKind = (f: Pick<LocalFile, "type" | "name">): "image" | "pdf" | "sheet" | "doc" | "other" => {
  const t = f.type.toLowerCase(), n = f.name.toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (/\.(csv|xlsx?|ods)$/.test(n) || t.includes("spreadsheet") || t.includes("excel")) return "sheet";
  if (/\.(docx?|txt|md|rtf|odt)$/.test(n) || t.startsWith("text/") || t.includes("word")) return "doc";
  return "other";
};

export function downloadBlob(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
