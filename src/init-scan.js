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
  const group = db.prepare("SELECT * FROM source_groups LIMIT 1").get();
  if (!group) {
    console.error('No source group found. Run /join first via the bot.');
    process.exit(1);
  }

  const chatId = group.chat_id;

  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  await client.connect();

  if (!(await client.isUserAuthorized())) {
    console.error('Not authorized. Create a session string first: see scripts/login.js');
    process.exit(1);
  }

  console.log(`Scanning group ${chatId} (${group.title || 'unknown'})...`);

  const entity = await client.getEntity(chatId);
  let count = 0;
  let batch = [];

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO media_index
      (title, year, season, episode, resolution, source, codec,
       audio, channels, language, release_group, file_type,
       package_id, part_number, file_size,
       source_chat_id, source_msg_id, raw_filename)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for await (const msg of client.iterMessages(entity, { limit: 200 })) {
    const filename = getFilename(msg);
    if (!filename) continue;

    const alreadyIndexed = db.prepare(
      "SELECT id FROM media_index WHERE source_chat_id = ? AND source_msg_id = ?"
    ).get(chatId, msg.id);
    if (alreadyIndexed) continue;

    const parsed = parseFilename(filename);
    if (!parsed) continue;

    const fileSize = msg.file?.size || 0;

    batch.push([
      parsed.title, parsed.year || null, parsed.season || null, parsed.episode || null,
      parsed.resolution || null, parsed.source || null, parsed.codec || null,
      parsed.audio || null, parsed.channels || null, parsed.language || null,
      parsed.group || null, parsed.file_type || 'video',
      parsed.package_id || null, parsed.part_number || null, fileSize,
      chatId, msg.id, filename,
    ]);

    count++;

    if (batch.length >= 50) {
      db.transaction((rows) => { for (const r of rows) insertStmt.run(...r); })(batch);
      batch = [];
      console.log(`  Indexed ${count} files so far...`);
    }
  }

  if (batch.length > 0) {
    db.transaction((rows) => { for (const r of rows) insertStmt.run(...r); })(batch);
  }

  console.log(`✅ Scan complete. Indexed ${count} new files.`);
  await client.disconnect();
}

function getFilename(msg) {
  if (msg.file?.name) {
    if (msg.document || msg.video) return msg.file.name;
  }
  return null;
}
