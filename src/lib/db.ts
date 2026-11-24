import type { ChatTurn, EpisodeRecord, GuideRecord } from './types';

const DB_NAME = 'subcast';
const DB_VERSION = 1;
export const STORE_EPISODES = 'episodes';
export const STORE_GUIDES = 'guides';
export const STORE_CHATS = 'chats';

let opening: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_EPISODES)) db.createObjectStore(STORE_EPISODES, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_GUIDES)) db.createObjectStore(STORE_GUIDES, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_CHATS)) db.createObjectStore(STORE_CHATS, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被另一个页面占用'));
  });
  return opening;
}

function request<T>(store: IDBObjectStore, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const r = op(store);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB 操作失败'));
  });
}

export async function getEpisode(key: string): Promise<EpisodeRecord | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_EPISODES, 'readonly');
  const rec = await request<EpisodeRecord | undefined>(tx.objectStore(STORE_EPISODES), (s) => s.get(key));
  return rec ?? null;
}

export async function putEpisode(rec: EpisodeRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_EPISODES, 'readwrite');
  await request(tx.objectStore(STORE_EPISODES), (s) => s.put(rec));
}

/** Read-modify-write in one transaction, so parallel translation batches don't clobber each other. */
export async function updateEpisode(
  key: string,
  fn: (rec: EpisodeRecord) => EpisodeRecord | null | void,
): Promise<EpisodeRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_EPISODES, 'readwrite');
    const store = tx.objectStore(STORE_EPISODES);
    const get = store.get(key) as IDBRequest<EpisodeRecord | undefined>;
    let result: EpisodeRecord | null = null;
    get.onsuccess = () => {
      const cur = get.result;
      if (!cur) {
        resolve(null);
        return;
      }
      const next = fn(cur);
      result = next === undefined ? cur : next;
      if (result) store.put(result);
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 写入取消'));
  });
}

export async function deleteEpisode(key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_EPISODES, 'readwrite');
  await request(tx.objectStore(STORE_EPISODES), (s) => s.delete(key));
}

export async function getGuide(key: string): Promise<GuideRecord | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_GUIDES, 'readonly');
  const rec = await request<GuideRecord | undefined>(tx.objectStore(STORE_GUIDES), (s) => s.get(key));
  return rec ?? null;
}

export async function putGuide(rec: GuideRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_GUIDES, 'readwrite');
  await request(tx.objectStore(STORE_GUIDES), (s) => s.put(rec));
}

export async function getChat(key: string): Promise<ChatTurn[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_CHATS, 'readonly');
  const rec = await request<{ key: string; turns: ChatTurn[] } | undefined>(tx.objectStore(STORE_CHATS), (s) => s.get(key));
  return rec?.turns ?? [];
}

export async function putChat(key: string, turns: ChatTurn[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_CHATS, 'readwrite');
  await request(tx.objectStore(STORE_CHATS), (s) => s.put({ key, turns: turns.slice(-100) }));
}

/** Storage estimate for the options page: how much the episode cache takes. */
export async function storageInfo(): Promise<{ episodes: number; guides: number; bytes: number }> {
  const db = await openDb();
  const tx = db.transaction([STORE_EPISODES, STORE_GUIDES], 'readonly');
  const [episodes, guides] = await Promise.all([
    request<number>(tx.objectStore(STORE_EPISODES), (s) => s.count()),
    request<number>(tx.objectStore(STORE_GUIDES), (s) => s.count()),
  ]);
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  return { episodes, guides, bytes: estimate?.usage ?? 0 };
}

/** Delete cached transcripts and guides (chats are kept). */
export async function clearCachedEpisodes(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_EPISODES, STORE_GUIDES], 'readwrite');
  tx.objectStore(STORE_EPISODES).clear();
  tx.objectStore(STORE_GUIDES).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('清理缓存失败'));
  });
}
