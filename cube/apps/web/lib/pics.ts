// 本地卡图绑定（dev_docs/06 §5）：showDirectoryPicker 显式授权后，把
// FileSystemDirectoryHandle 存入 IndexedDB；之后按相对路径（pics/、expansions/...）
// 直接读取本地图片。仅在 Chromium 系可用，其余浏览器回退到手动路径/服务端代理。

export type PicsDirHandle = FileSystemDirectoryHandle;

const DB_NAME = 'yc-pics';
const STORE = 'handles';
const KEY = 'root';
let cachedHandle: PicsDirHandle | null | undefined;
let handleLoad: Promise<PicsDirHandle | null> | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
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
  cachedHandle = handle;
  expansionsCache.delete(handle);
  permissionChecks.delete(handle);
}

export async function getDirHandle(): Promise<PicsDirHandle | null> {
  if (cachedHandle !== undefined) return cachedHandle;
  if (handleLoad) return handleLoad;
  handleLoad = (async () => {
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
  })();
  try {
    cachedHandle = await handleLoad;
    return cachedHandle;
  } finally {
    handleLoad = null;
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
    cachedHandle = null;
  } catch {
    // ignore
  }
}

// TS DOM 类型较旧，运行时 API 自带；这里用宽接口访问权限方法
interface PermissibleDirHandle extends PicsDirHandle {
  queryPermission(opts: { mode: string }): Promise<string>;
  requestPermission(opts: { mode: string }): Promise<string>;
}

const permissionChecks = new WeakMap<object, Promise<boolean>>();

export async function requestDirPermission(handle: PicsDirHandle): Promise<boolean> {
  const existing = permissionChecks.get(handle);
  if (existing) return existing;
  const check = (async () => {
    try {
      const p = handle as PermissibleDirHandle;
      if ((await p.queryPermission({ mode: 'read' })) === 'granted') return true;
      return (await p.requestPermission({ mode: 'read' })) === 'granted';
    } catch {
      return false;
    }
  })();
  permissionChecks.set(handle, check);
  if (!(await check)) permissionChecks.delete(handle);
  return check;
}

const expansionsCache = new WeakMap<object, string[]>();

async function listExpansionDirs(handle: PicsDirHandle): Promise<string[]> {
  const cached = expansionsCache.get(handle);
  if (cached) return cached;
  const dirs: string[] = [];
  try {
    const expansions = await handle.getDirectoryHandle('expansions', { create: false });
    for await (const [name, entry] of (expansions as any).entries()) {
      if (entry.kind === 'directory' && name !== 'pics') dirs.push(name);
    }
  } catch {
    // no expansions dir
  }
  expansionsCache.set(handle, dirs);
  return dirs;
}

// Expansion art overrides the base image, matching YGOPro ImageManager.
const imageExtensions = ['jpg', 'png', 'jpeg', 'webp', 'avif'];
export function localCardImagePaths(code: number): string[] {
  return ['expansions/pics', 'pics', ''].flatMap(dir =>
    imageExtensions.map(extension => `${dir ? dir + '/' : ''}${code}.${extension}`));
}

export async function readCardImageUrl(handle: PicsDirHandle, code: number): Promise<string | null> {
  async function read(paths: string[]): Promise<string | null> {
    for (const rel of paths) {
      try {
        const parts = rel.split('/');
        let dir = handle;
        for (let i = 0; i < parts.length - 1; i++)
          dir = await dir.getDirectoryHandle(parts[i], { create: false });
        const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: false });
        const file = await fileHandle.getFile();
        if (file.size) return URL.createObjectURL(file);
      } catch {
        // Missing or unreadable files fall through to the next local candidate.
      }
    }
    return null;
  }
  const paths = localCardImagePaths(code);
  // Try the standard expansion folder before enumerating optional pack folders.
  const expansion = await read(paths.filter(p => p.startsWith('expansions/')));
  if (expansion) return expansion;
  for (const dir of await listExpansionDirs(handle)) {
    const image = await read(imageExtensions.map(ext => `expansions/${dir}/pics/${code}.${ext}`));
    if (image) return image;
  }
  return read(paths.filter(p => !p.startsWith('expansions/')));
}
