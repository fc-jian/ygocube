import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config';

// SQLite schema (dev_docs/05 §8). One connection, WAL, transactions where multi-write.
let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.server.dbPath), { recursive: true });
  db = new Database(config.server.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'registration',
      round INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tournament_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      seat INTEGER,
      joined_at TEXT NOT NULL,
      eliminated INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tournament_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS packs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      "index" INTEGER NOT NULL,
      size INTEGER NOT NULL,
      drop_card_code INTEGER,
      order_json TEXT NOT NULL,
      UNIQUE(tournament_id, "index")
    );
    CREATE TABLE IF NOT EXISTS picks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      pack_index INTEGER NOT NULL,
      pick_round INTEGER NOT NULL,
      card_code INTEGER NOT NULL,
      auto_picked INTEGER NOT NULL DEFAULT 0,
      picked_at TEXT NOT NULL,
      UNIQUE(tournament_id, player_id, pack_index, pick_round)
    );
    CREATE TABLE IF NOT EXISTS decks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      main_json TEXT NOT NULL DEFAULT '[]',
      extra_json TEXT NOT NULL DEFAULT '[]',
      side_json TEXT NOT NULL DEFAULT '[]',
      locked_at TEXT,
      status TEXT NOT NULL DEFAULT 'building',
      UNIQUE(tournament_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      round INTEGER NOT NULL,
      player_a TEXT NOT NULL,
      player_b TEXT NOT NULL,
      table_no INTEGER NOT NULL,
      room_name TEXT,
      room_status_json TEXT,
      result_a INTEGER,
      result_b INTEGER,
      source TEXT,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      entity TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      actor TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tournament_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      code INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      type INTEGER NOT NULL DEFAULT 0,
      desc TEXT NOT NULL DEFAULT '',
      level INTEGER NOT NULL DEFAULT 0,
      race INTEGER NOT NULL DEFAULT 0,
      attribute INTEGER NOT NULL DEFAULT 0,
      atk INTEGER NOT NULL DEFAULT 0,
      def INTEGER NOT NULL DEFAULT 0,
      alias INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS card_pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      codes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  migrate(db);
  return db;
}

// lightweight migrations for existing databases
function migrate(d: Database.Database): void {
  const cols = d.prepare('PRAGMA table_info(tournaments)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'admin_token_hash')) {
    d.exec('ALTER TABLE tournaments ADD COLUMN admin_token_hash TEXT');
  }
  if (!cols.some((c) => c.name === 'auth_required')) {
    d.exec('ALTER TABLE tournaments ADD COLUMN auth_required INTEGER NOT NULL DEFAULT 1');
  }
  if (!cols.some((c) => c.name === 'frozen')) {
    d.exec('ALTER TABLE tournaments ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0');
  }
  const matchCols = d.prepare('PRAGMA table_info(matches)').all() as { name: string }[];
  if (!matchCols.some((c) => c.name === 'player_a_pass')) {
    d.exec('ALTER TABLE matches ADD COLUMN player_a_pass TEXT');
    d.exec('ALTER TABLE matches ADD COLUMN player_b_pass TEXT');
  }
  const cardCols = d.prepare('PRAGMA table_info(cards)').all() as { name: string }[];
  if (!cardCols.some((c) => c.name === 'desc')) {
    d.exec("ALTER TABLE cards ADD COLUMN desc TEXT NOT NULL DEFAULT ''");
  }
  if (!cardCols.some((c) => c.name === 'level')) {
    d.exec('ALTER TABLE cards ADD COLUMN level INTEGER NOT NULL DEFAULT 0');
    d.exec('ALTER TABLE cards ADD COLUMN race INTEGER NOT NULL DEFAULT 0');
    d.exec('ALTER TABLE cards ADD COLUMN attribute INTEGER NOT NULL DEFAULT 0');
    d.exec('ALTER TABLE cards ADD COLUMN atk INTEGER NOT NULL DEFAULT 0');
    d.exec('ALTER TABLE cards ADD COLUMN def INTEGER NOT NULL DEFAULT 0');
  }
  if (!cardCols.some((c) => c.name === 'alias')) {
    d.exec('ALTER TABLE cards ADD COLUMN alias INTEGER NOT NULL DEFAULT 0');
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined as unknown as Database.Database;
  }
}
