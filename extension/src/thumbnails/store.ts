const DB_NAME = 'acv-thumbnails-v2';
const STORE_NAME = 'thumbs';
export const THUMB_UPDATED_EVENT = 'acv:thumb-updated';

const memCache = new Map<string, string>();
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function getThumbnail(keys: string[]): Promise<string | null> {
  for (const k of keys) {
    if (!k) continue;
    const hit = memCache.get(k);
    if (hit) return hit;
  }
  try {
    const db = await openDb();
    for (const k of keys) {
      if (!k) continue;
      const val = await new Promise<string | null>((res) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const r = tx.objectStore(STORE_NAME).get(k);
        r.onsuccess = () => res(typeof r.result === 'string' ? r.result : null);
        r.onerror = () => res(null);
      });
      if (val) {
        for (const alias of keys) if (alias) memCache.set(alias, val);
        return val;
      }
    }
  } catch {
    /* ignore IDB errors */
  }
  return null;
}

export async function saveThumbnail(keys: string[], dataUrl: string): Promise<void> {
  const valid = keys.filter(Boolean);
  for (const k of valid) memCache.set(k, dataUrl);
  try {
    const db = await openDb();
    await new Promise<void>((res) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const k of valid) store.put(dataUrl, k);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch {
    /* ignore IDB errors */
  }
  document.dispatchEvent(new CustomEvent(THUMB_UPDATED_EVENT, { detail: { keys: valid, dataUrl } }));
}

export async function clearAllThumbnails(): Promise<void> {
  memCache.clear();
  try {
    const db = await openDb();
    await new Promise<void>((res) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch {
    /* ignore */
  }
  try {
    indexedDB.deleteDatabase('acv-splat-cache-v3');
  } catch {
    /* ignore */
  }
  document.dispatchEvent(new CustomEvent(THUMB_UPDATED_EVENT, { detail: { cleared: true } }));
}
