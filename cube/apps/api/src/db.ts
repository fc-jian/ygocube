import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config';

// SQLite schema (dev_docs/05 §8). One connection, WAL, transactions where multi-write.
let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = config.server.dbPath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const hadDatabase = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
  db = new Database(config.server.dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 1000');
  // Keep a recoverable copy before the first creator-scope migration. A WAL
  // checkpoint makes copying the main file sufficient and avoids capturing a
  // half-written sidecar. The backup is intentionally retained for an
  // operator-led rollback rather than deleted automatically.
  const migrationBackup = `${dbPath}.pre-auth-migration.bak`;
  if (hadDatabase && !fs.existsSync(migrationBackup)) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(dbPath, migrationBackup);
    } catch (error) {
      db.close();
      db = undefined as unknown as Database.Database;
      throw new Error(`database backup failed before migration: ${(error as Error).message}`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'unknown',
      card_pool_id INTEGER,
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
      withdrawn INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
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
      faulted_at TEXT,
      started_at TEXT,
      finished_at TEXT
      ,stage TEXT
      ,bracket_round INTEGER
      ,bracket_match_id TEXT
      ,UNIQUE(tournament_id, round, table_no)
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
      ,lscale INTEGER NOT NULL DEFAULT 0
      ,rscale INTEGER NOT NULL DEFAULT 0
      ,link_markers INTEGER NOT NULL DEFAULT 0
      ,setcodes_json TEXT NOT NULL DEFAULT '[]'
      ,setnames_json TEXT NOT NULL DEFAULT '[]'
      ,search_text TEXT NOT NULL DEFAULT ''
      ,metadata_version INTEGER NOT NULL DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS create_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
  `);
  try {
    migrate(db);
  } catch (error) {
    // Restore only when a pre-migration copy exists. This is a fail-closed
    // path: a partial permission migration must never leave the service
    // serving an unknown schema.
    if (fs.existsSync(migrationBackup)) {
      try {
        db.close();
        fs.copyFileSync(migrationBackup, dbPath);
        for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
      } catch (restoreError) {
        throw new Error(`database migration failed and rollback failed: ${(restoreError as Error).message}`);
      }
    }
    db = undefined as unknown as Database.Database;
    throw error;
  }
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
  if (!cols.some((c) => c.name === 'created_by')) {
    d.exec("ALTER TABLE tournaments ADD COLUMN created_by TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!cols.some((c) => c.name === 'card_pool_id')) {
    d.exec('ALTER TABLE tournaments ADD COLUMN card_pool_id INTEGER');
  }
  // Per-tournament admin tokens are revoked as part of the creator-scoped
  // administration migration. Keep the nullable legacy column for SQLite
  // compatibility with old databases, but never populate or authenticate it.
  if (cols.some((c) => c.name === 'admin_token_hash')) d.exec('UPDATE tournaments SET admin_token_hash=NULL WHERE admin_token_hash IS NOT NULL');
  d.exec('CREATE INDEX IF NOT EXISTS idx_tournaments_created_by ON tournaments(created_by)');
  const snapCols = d.prepare('PRAGMA table_info(tournament_snapshots)').all() as { name: string }[];
  if (!snapCols.some((c) => c.name === 'event_seq')) {
    // 快照记录全局事件 seq（旧行 seq 是相对计数，语义错配会导致重放翻倍，修复后忽略旧行）
    d.exec('ALTER TABLE tournament_snapshots ADD COLUMN event_seq INTEGER');
  }
  const matchCols = d.prepare('PRAGMA table_info(matches)').all() as { name: string }[];
  if (!matchCols.some((c) => c.name === 'player_a_pass')) {
    d.exec('ALTER TABLE matches ADD COLUMN player_a_pass TEXT');
    d.exec('ALTER TABLE matches ADD COLUMN player_b_pass TEXT');
  }
  if (!matchCols.some((c) => c.name === 'faulted_at')) {
    d.exec('ALTER TABLE matches ADD COLUMN faulted_at TEXT');
  }
  if (!matchCols.some((c) => c.name === 'stage')) {
    d.exec('ALTER TABLE matches ADD COLUMN stage TEXT');
    d.exec('ALTER TABLE matches ADD COLUMN bracket_round INTEGER');
    d.exec('ALTER TABLE matches ADD COLUMN bracket_match_id TEXT');
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
  for (const [name, ddl] of [
    ['lscale', 'INTEGER NOT NULL DEFAULT 0'],
    ['rscale', 'INTEGER NOT NULL DEFAULT 0'],
    ['link_markers', 'INTEGER NOT NULL DEFAULT 0'],
    ['setcodes_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['setnames_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['search_text', "TEXT NOT NULL DEFAULT ''"],
    ['metadata_version', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    if (!cardCols.some((c) => c.name === name)) d.exec(`ALTER TABLE cards ADD COLUMN ${name} ${ddl}`);
  }
  const playerCols = d.prepare('PRAGMA table_info(tournament_players)').all() as { name: string }[];
  if (!playerCols.some((c) => c.name === 'active')) {
    d.exec('ALTER TABLE tournament_players ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  }
  if (!playerCols.some((c) => c.name === 'withdrawn')) {
    d.exec('ALTER TABLE tournament_players ADD COLUMN withdrawn INTEGER NOT NULL DEFAULT 0');
  }
  d.exec('CREATE INDEX IF NOT EXISTS idx_cards_search_text ON cards(search_text)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_events_tid_seq ON events(tournament_id, seq)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_tournaments_pool_status ON tournaments(card_pool_id, status)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_players_tid_active ON tournament_players(tournament_id, active)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_matches_pending ON matches(tournament_id, result_a, room_name)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_matches_room_name ON matches(room_name)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_picks_tid_pack_round ON picks(tournament_id, pack_index, pick_round)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_snapshots_tid_event ON tournament_snapshots(tournament_id, event_seq)');
  try {
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_tid_round_table ON matches(tournament_id, round, table_no)');
  } catch (error) {
    // Do not make an existing deployment unbootable. Historical duplicates are
    // surfaced for administrator repair; all new databases enforce uniqueness.
    console.error('cannot enforce unique match tables: historical duplicates exist', error);
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined as unknown as Database.Database;
  }
}
