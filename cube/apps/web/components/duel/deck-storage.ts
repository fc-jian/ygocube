import type { BrowserDeck } from '@ygocube/shared';
import { readDecks as legacyDecks, deleteDeck as deleteLegacyDeck, type SavedDeck } from './deck-cookie';
export { ydk, parseYdk, type SavedDeck } from './deck-cookie';

const STORAGE_ERROR = '卡组保存失败，请检查浏览器存储权限并导出备份 / Deck storage unavailable; export a backup';
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error(STORAGE_ERROR));
    const request = indexedDB.open('ygocube-duel-decks', 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore('decks', { keyPath: 'id' });
      request.result.createObjectStore('migrated');
    };
    request.onerror = () => reject(new Error(STORAGE_ERROR));
    request.onblocked = () => { blocked = true; reject(new Error(STORAGE_ERROR)); };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
function transaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(new Error(STORAGE_ERROR));
    tx.onerror = () => { /* onabort reports the transaction failure. */ };
    try { work(tx, result => { value = result; }); } catch (error) { tx.abort(); reject(error); }
  });
}
async function migrate(db: IDBDatabase): Promise<void> {
  const legacy = legacyDecks();
  if (!legacy.length) return;
  await transaction<void>(db, ['decks', 'migrated'], 'readwrite', tx => {
    const decks = tx.objectStore('decks'), migrated = tx.objectStore('migrated');
    for (const deck of legacy) {
      const marker = migrated.get(deck.id);
      marker.onsuccess = () => {
        if (marker.result) return;
        const existing = decks.get(deck.id);
        existing.onsuccess = () => {
          if (!existing.result) decks.put(deck);
          migrated.put(true, deck.id);
        };
      };
    }
  });
  // Only remove cookies after commit. Markers prevent deleted decks returning
  // when cookie deletion was blocked or an older browser tab writes them again.
  for (const deck of legacy) deleteLegacyDeck(deck.id);
}
async function database<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await open();
  try { await migrate(db); return await work(db); } finally { db.close(); }
}
function validate(deck: BrowserDeck, id: string): void {
  if (!/^[a-f0-9]{32}$/.test(id) || typeof deck.name !== 'string' || deck.name.length > 100
    || [deck.main, deck.extra, deck.side].some(zone => !Array.isArray(zone) || zone.length > 200 || zone.some(code => !Number.isInteger(code) || code <= 0 || code > 0xffffffff))
    || deck.main.length + deck.extra.length + deck.side.length > 500) throw new Error('卡组格式或数量无效 / Invalid deck');
}
export async function readDecks(): Promise<SavedDeck[]> {
  return database(db => transaction<SavedDeck[]>(db, ['decks'], 'readonly', (tx, done) => {
    const request = tx.objectStore('decks').getAll();
    request.onsuccess = () => done(request.result.filter((deck: SavedDeck) => { try { validate(deck, deck.id); return true; } catch { return false; } }));
  }));
}
export async function saveDeck(deck: BrowserDeck, id = crypto.randomUUID().replaceAll('-', '')): Promise<string> {
  validate(deck, id);
  // Snapshot before the first await; later editor changes cannot alter this save.
  const saved = { id, name: deck.name, main: [...deck.main], extra: [...deck.extra], side: [...deck.side] };
  await database(db => transaction<void>(db, ['decks', 'migrated'], 'readwrite', tx => {
    tx.objectStore('decks').put(saved);
    tx.objectStore('migrated').put(true, id);
  }));
  return id;
}
export async function deleteDeck(id: string): Promise<void> {
  await database(db => transaction<void>(db, ['decks', 'migrated'], 'readwrite', tx => {
    tx.objectStore('decks').delete(id);
    tx.objectStore('migrated').put(true, id);
  }));
}
