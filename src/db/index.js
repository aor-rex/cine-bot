import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const DB_PATH = join(DATA_DIR, 'cine.db');

let db;

export function getDb() {
  if (!db) {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      year INTEGER,
      season INTEGER,
      episode INTEGER,
      absolute_episode INTEGER,
      episode_end INTEGER,
      episode_title TEXT,
      resolution TEXT,
      quality_norm TEXT,
      source TEXT,
      codec TEXT,
      audio TEXT,
      channels REAL,
      language TEXT,
      release_group TEXT,
      version INTEGER DEFAULT 1,
      edition TEXT,
      file_type TEXT NOT NULL DEFAULT 'video',
      package_id TEXT,
      part_number INTEGER,
      total_parts INTEGER,
      file_size INTEGER,
      source_chat_id INTEGER NOT NULL,
      source_msg_id INTEGER NOT NULL,
      raw_filename TEXT NOT NULL,
      scanned_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_chat_id, source_msg_id)
    );

    CREATE INDEX IF NOT EXISTS idx_media_title ON media_index(title);
    CREATE INDEX IF NOT EXISTS idx_media_season ON media_index(season);
    CREATE INDEX IF NOT EXISTS idx_media_type ON media_index(file_type);
    CREATE INDEX IF NOT EXISTS idx_media_package ON media_index(package_id);
    CREATE INDEX IF NOT EXISTS idx_media_raw_filename ON media_index(raw_filename);

    CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
      title, episode_title, release_group,
      content='media_index',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS media_ai AFTER INSERT ON media_index BEGIN
      INSERT INTO media_fts(rowid, title, episode_title, release_group)
      VALUES (new.id, new.title, new.episode_title, new.release_group);
    END;

    CREATE TRIGGER IF NOT EXISTS media_ad AFTER DELETE ON media_index BEGIN
      INSERT INTO media_fts(media_fts, rowid, title, episode_title, release_group)
      VALUES ('delete', old.id, old.title, old.episode_title, old.release_group);
    END;

    CREATE TRIGGER IF NOT EXISTS media_au AFTER UPDATE ON media_index BEGIN
      INSERT INTO media_fts(media_fts, rowid, title, episode_title, release_group)
      VALUES ('delete', old.id, old.title, old.episode_title, old.release_group);
      INSERT INTO media_fts(rowid, title, episode_title, release_group)
      VALUES (new.id, new.title, new.episode_title, new.release_group);
    END;

    CREATE TABLE IF NOT EXISTS title_overrides (
      raw_pattern TEXT PRIMARY KEY,
      corrected_title TEXT NOT NULL,
      match_type TEXT DEFAULT 'exact'
    );

    CREATE TABLE IF NOT EXISTS parse_rejects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_filename TEXT NOT NULL,
      reason TEXT,
      source_chat_id INTEGER,
      source_msg_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      user_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_request_log_title ON request_log(title);

    CREATE TABLE IF NOT EXISTS owners (
      user_id INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS source_groups (
      chat_id INTEGER PRIMARY KEY,
      title TEXT,
      type TEXT DEFAULT 'channel',
      joined_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS bot_chats (
      chat_id INTEGER PRIMARY KEY,
      title TEXT,
      type TEXT,
      added_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migration: add type column if missing (existing DBs)
  try { db.exec("ALTER TABLE source_groups ADD COLUMN type TEXT DEFAULT 'channel'"); } catch {}

  // Migration: add backup_msg_id column if missing (existing DBs)
  try { db.exec("ALTER TABLE media_index ADD COLUMN backup_msg_id INTEGER"); } catch {}

  // Migration: add backup_retries column if missing (existing DBs)
  try { db.exec("ALTER TABLE media_index ADD COLUMN backup_retries INTEGER DEFAULT 0"); } catch {}

  // Migration: parsium-era columns (absolute numbering, ranges, normalized quality)
  try { db.exec("ALTER TABLE media_index ADD COLUMN absolute_episode INTEGER"); } catch {}
  try { db.exec("ALTER TABLE media_index ADD COLUMN episode_end INTEGER"); } catch {}
  try { db.exec("ALTER TABLE media_index ADD COLUMN quality_norm TEXT"); } catch {}
  try { db.exec("ALTER TABLE media_index ADD COLUMN version INTEGER DEFAULT 1"); } catch {}
  try { db.exec("ALTER TABLE media_index ADD COLUMN edition TEXT"); } catch {}
  try { db.exec("ALTER TABLE media_index ADD COLUMN episode_title TEXT"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_media_title_abs ON media_index(title, absolute_episode)"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_media_title_quality ON media_index(title, season, quality_norm)"); } catch {}
  try {
    db.exec(`CREATE TRIGGER IF NOT EXISTS media_au AFTER UPDATE ON media_index BEGIN
      INSERT INTO media_fts(media_fts, rowid, title, episode_title, release_group)
      VALUES ('delete', old.id, old.title, old.episode_title, old.release_group);
      INSERT INTO media_fts(rowid, title, episode_title, release_group)
      VALUES (new.id, new.title, new.episode_title, new.release_group);
    END;`);
  } catch {}

  // Seed: arc-title aliases (bare title grouping)
  try {
    db.prepare(`INSERT OR IGNORE INTO title_overrides (raw_pattern, corrected_title, match_type)
      VALUES ('Jujutsu Kaisen The Culling Game Part 1', 'Jujutsu Kaisen', 'exact')`).run();
  } catch {}
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
