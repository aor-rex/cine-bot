import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { getDb } from './db/index.js';
import { parseFilename } from './parser/index.js';

export async function initScan() {
  const apiId = Number(process.env.API_ID);
  const apiHash = process.env.API_HASH;
  const sessionString = process.env.SESSION_STRING || '';

  if (!apiId || !apiHash) {
    console.error('Set API_ID and API_HASH in .env for init-scan.');
    process.exit(1);
  }

  const db = getDb();
  const groups = db.prepare(`
    SELECT *
    FROM source_groups
    ORDER BY datetime(joined_at) DESC, rowid DESC
  `).all();
  if (groups.length === 0) {
    console.error('No source groups found. Run /join first via the bot.');
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  await client.connect();

  if (!(await client.isUserAuthorized())) {
    console.error('Not authorized. Create a session string first with: node src/login.js');
    process.exit(1);
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO media_index
      (title, year, season, episode, resolution, source, codec,
       audio, channels, language, release_group, file_type,
       package_id, part_number, file_size,
       source_chat_id, source_msg_id, raw_filename)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const messageExistsStmt = db.prepare(
    "SELECT id FROM media_index WHERE source_chat_id = ? AND source_msg_id = ?"
  );
  const duplicateFileStmt = db.prepare(
    "SELECT id, source_chat_id FROM media_index WHERE raw_filename = ? LIMIT 1"
  );

  let totalIndexed = 0;
  let totalSkippedDuplicates = 0;

  for (const group of groups) {
    const chatId = group.chat_id;
    console.log(`Scanning group ${chatId} (${group.title || 'unknown'})...`);

    const entity = await client.getEntity(chatId);
    let groupIndexed = 0;
    let groupSkippedDuplicates = 0;
    let batch = [];

    for await (const msg of client.iterMessages(entity)) {
      const filename = getFilename(msg);
      if (!filename) continue;

      const alreadyIndexed = messageExistsStmt.get(chatId, msg.id);
      if (alreadyIndexed) continue;

      const duplicateFile = duplicateFileStmt.get(filename);
      if (duplicateFile) {
        groupSkippedDuplicates++;
        totalSkippedDuplicates++;
        continue;
      }

      const parsed = parseFilename(filename);
      if (!parsed) continue;

      const fileSize = normalizeDbValue(msg.file?.size || 0);

      batch.push([
        normalizeDbValue(parsed.title),
        normalizeDbValue(parsed.year || null),
        normalizeDbValue(parsed.season || null),
        normalizeDbValue(parsed.episode || null),
        normalizeDbValue(parsed.resolution || null),
        normalizeDbValue(parsed.source || null),
        normalizeDbValue(parsed.codec || null),
        normalizeDbValue(parsed.audio || null),
        normalizeDbValue(parsed.channels || null),
        normalizeDbValue(parsed.language || null),
        normalizeDbValue(parsed.group || null),
        normalizeDbValue(parsed.file_type || 'video'),
        normalizeDbValue(parsed.package_id || null),
        normalizeDbValue(parsed.part_number || null),
        fileSize,
        normalizeDbValue(chatId),
        normalizeDbValue(msg.id),
        normalizeDbValue(filename),
      ]);

      groupIndexed++;
      totalIndexed++;

      if (batch.length >= 50) {
        db.transaction((rows) => { for (const r of rows) insertStmt.run(...r); })(batch);
        batch = [];
        console.log(`  Indexed ${groupIndexed} files so far from ${group.title || chatId}...`);
      }
    }

    if (batch.length > 0) {
      db.transaction((rows) => { for (const r of rows) insertStmt.run(...r); })(batch);
    }

    console.log(
      `✅ Group scan complete for ${group.title || chatId}. Indexed ${groupIndexed} new files`
      + (groupSkippedDuplicates ? `, skipped ${groupSkippedDuplicates} duplicates.` : '.')
    );
  }

  console.log(
    `✅ All scans complete. Indexed ${totalIndexed} new files`
    + (totalSkippedDuplicates ? `, skipped ${totalSkippedDuplicates} duplicates.` : '.')
  );
  await client.disconnect();
}

function getFilename(msg) {
  if (msg.file?.name) {
    if (msg.document || msg.video) return msg.file.name;
  }
  return null;
}

function normalizeDbValue(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
