import { getDb, closeDb } from './db/index.js';
import { parseFilename } from './parser/index.js';

// One-time backfill: re-parse raw_filename for existing rows and fill
// parsium-era columns (absolute_episode, episode_end, quality_norm, ...).
//
// Usage:
//   node src/reparse.js --dry-run   # parse all, report, write nothing
//   node src/reparse.js             # parse all, UPDATE rows in batches
//
// Back up data/cine.db before the real run.

const BATCH_SIZE = 500;
const DRY_RUN = process.argv.includes('--dry-run');

const COLS = [
  'title', 'year', 'season', 'episode', 'absolute_episode', 'episode_end',
  'episode_title', 'resolution', 'quality_norm', 'source', 'codec', 'audio',
  'channels', 'language', 'release_group', 'version', 'edition',
];

function normalize(v) {
  return v ?? null;
}

async function main() {
  const db = getDb();
  try {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS parse_rejects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_filename TEXT NOT NULL,
        reason TEXT,
        source_chat_id INTEGER,
        source_msg_id INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
    } catch {}

    const total = db.prepare('SELECT COUNT(*) AS c FROM media_index').get().c;
    console.log(`${DRY_RUN ? '[dry-run] ' : ''}Reparsing ${total} rows...`);

    const selectStmt = db.prepare(
      'SELECT id, raw_filename, source_chat_id, source_msg_id FROM media_index ORDER BY id LIMIT ? OFFSET ?'
    );
    const updateStmt = db.prepare(`
      UPDATE media_index SET
        title = ?, year = ?, season = ?, episode = ?, absolute_episode = ?,
        episode_end = ?, episode_title = ?, resolution = ?, quality_norm = ?,
        source = ?, codec = ?, audio = ?, channels = ?, language = ?,
        release_group = ?, version = ?, edition = ?
      WHERE id = ?
    `);
    const rejectStmt = db.prepare(`
      INSERT INTO parse_rejects (raw_filename, reason, source_chat_id, source_msg_id)
      VALUES (?, ?, ?, ?)
    `);

    let updated = 0;
    let rejects = 0;
    let failed = 0;

    for (let offset = 0; offset < total; offset += BATCH_SIZE) {
      const rows = selectStmt.all(BATCH_SIZE, offset);
      if (!DRY_RUN) {
        const tx = db.transaction((batch) => {
          for (const r of batch) {
            let parsed;
            try {
              parsed = parseFilename(r.raw_filename, { db });
            } catch {
              parsed = null;
            }
            if (!parsed) {
              try { rejectStmt.run(r.raw_filename, 'unparsable', r.source_chat_id, r.source_msg_id); } catch {}
              rejects++;
              continue;
            }
            updateStmt.run(
              normalize(parsed.title),
              normalize(parsed.year),
              normalize(parsed.season),
              normalize(parsed.episode),
              normalize(parsed.absolute_episode),
              normalize(parsed.episode_end),
              normalize(parsed.episode_title),
              normalize(parsed.resolution),
              normalize(parsed.quality_norm),
              normalize(parsed.source),
              normalize(parsed.codec),
              normalize(parsed.audio),
              normalize(parsed.channels),
              normalize(parsed.language),
              normalize(parsed.release_group),
              normalize(parsed.version ?? 1),
              normalize(parsed.edition),
              r.id
            );
            updated++;
          }
        });
        try {
          tx(rows);
        } catch (err) {
          failed += rows.length;
          console.log(`Batch @${offset} failed: ${err.message}`);
        }
      } else {
        for (const r of rows) {
          let parsed;
          try {
            parsed = parseFilename(r.raw_filename);
          } catch {
            parsed = null;
          }
          if (!parsed) rejects++;
          else updated++;
        }
      }
      console.log(`  ...${Math.min(offset + BATCH_SIZE, total)}/${total} (would-update=${updated}, rejects=${rejects})`);
    }

    console.log(
      `${DRY_RUN ? '[dry-run] done. Would update' : 'Done. Updated'} ${updated} rows, ${rejects} rejects`
      + (failed ? `, ${failed} failed` : '')
      + (DRY_RUN ? ' (no writes made).' : '.')
    );
    if (rejects > 0) {
      console.log("Inspect with: SELECT raw_filename, reason FROM parse_rejects ORDER BY id DESC LIMIT 20;");
    }
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error(`Reparse failed: ${err.message}`);
  process.exit(1);
});
