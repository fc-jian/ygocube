// 本地卡图绑定（dev_docs/06 §5）：showDirectoryPicker 显式授权后，把
// FileSystemDirectoryHandle 存入 IndexedDB；之后按相对路径（pics/、expansions/...）
// 直接读取本地图片。仅在 Chromium 系可用，其余浏览器回退到手动路径/服务端代理。

export type PicsDirHandle = FileSystemDirectoryHandle;

const DB_NAME = 'yc-pics';
const STORE = 'handles';
const KEY = 'root';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDirHandle(handle: PicsDirHandle): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getDirHandle(): Promise<PicsDirHandle | null> {
  try {
    const db = await openDb();
    const result = await new Promise<PicsDirHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as PicsDirHandle) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

export async function removeDirHandle(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}

// TS DOM 类型较旧，运行时 API 自带；这里用宽接口访问权限方法
interface PermissibleDirHandle extends PicsDirHandle {
  queryPermission(opts: { mode: string }): Promise<string>;
  requestPermission(opts: { mode: string }): Promise<string>;
}

export async function requestDirPermission(handle: PicsDirHandle): Promise<boolean> {
  try {
    const p = handle as PermissibleDirHandle;
    if ((await p.queryPermission({ mode: 'read' })) === 'granted') return true;
    return (await p.requestPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

let expansionsCache: string[] | null = null;

async function listExpansionDirs(handle: PicsDirHandle): Promise<string[]> {
  if (expansionsCache) return expansionsCache;
  const dirs: string[] = [];
  try {
    const expansions = await handle.getDirectoryHandle('expansions', { create: false });
    for await (const [name] of (expansions as any).entries()) {
      dirs.push(name);
    }
  } catch {
    // no expansions dir
  }
  expansionsCache = dirs;
  return dirs;
}

// 按相对路径读取卡图，返回 objectURL；找不到返回 null
export async function readCardImageUrl(handle: PicsDirHandle, code: number): Promise<string | null> {
  const candidates: string[] = [`pics/${code}.jpg`, `expansions/pics/${code}.jpg`];
  for (const dir of await listExpansionDirs(handle)) {
    candidates.push(`expansions/${dir}/pics/${code}.jpg`);
  }
  for (const rel of candidates) {
    try {
      // getFileHandle 不支持含 '/' 的相对路径：逐级进入子目录
      const parts = rel.split('/');
      let dir = handle;
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i]);
      }
      const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
      const file = await fileHandle.getFile();
      if (file.size === 0) continue;
      return URL.createObjectURL(file);
    } catch {
      // try next candidate
    }
  }
  return null;
}
