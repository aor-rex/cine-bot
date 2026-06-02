import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

let bot;

export async function startBot() {
  const db = getDb();

  // Restore source channel from DB on startup
  const source = db.prepare("SELECT * FROM source_groups WHERE type = 'channel' LIMIT 1").get();
  let sourceChatId = source ? source.chat_id : null;
  if (sourceChatId) console.log(`Source channel restored: ${source.title || source.chat_id}`);

  bot = new Bot(config.botToken);

  bot.use(async (ctx, next) => {
    try { await next(); }
    catch (err) { console.error('Bot error:', err.message); }
  });

  bot.command('start', (ctx) => {
    ctx.reply(
      '👋 Welcome to **Cine**!\n\n'
      + '`/request <title>` — search movies and series\n'
      + '`/myid` — get your user ID\n'
      + '`/source` — show current source channel info\n'
      + '`/cancel` — cancel current operation',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('myid', (ctx) => {
    ctx.reply(`Your user ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
  });

  // ── /join <chat_id> (owner-only, manual override) ──────
  bot.command('join', async (ctx) => {
    if (ctx.from.id !== config.ownerUserId) {
      return ctx.reply('⛔ Only the bot owner can use this command.');
    }
    const chatId = Number(ctx.match?.trim());
    if (!chatId) {
      return ctx.reply('Usage: `/join -1001234567890`', { parse_mode: 'Markdown' });
    }
    try {
      const chat = await ctx.api.getChat(chatId);
      const db = getDb();
      db.prepare(
        "INSERT OR REPLACE INTO source_groups (chat_id, title, type) VALUES (?, ?, ?)"
      ).run(chat.id, chat.title || null, chat.type === 'channel' ? 'channel' : 'supergroup');
      ctx.reply(
        `✅ Source set to: ${chat.title || chat.id} (${chat.type})\n\n`
        + 'Now add `API_ID`, `API_HASH`, `SESSION_STRING` to .env and run:\n'
        + '`node src/index.js init-scan`\n\n'
        + 'Then remove those env vars for production.'
      );
    } catch (err) {
      ctx.reply(`❌ Failed: ${err.message}`);
    }
  });

  // ── /request ────────────────────────────────────────────
  bot.command('request', async (ctx) => {
    const query = ctx.match?.trim();
    if (!query) {
      return ctx.reply('Usage: `/request <movie or series title>`', { parse_mode: 'Markdown' });
    }

    const db = getDb();
    const results = db.prepare(`
      SELECT m.id, m.title, m.year, m.season, m.episode,
             m.resolution, m.codec, m.source, m.file_type,
             m.file_size, m.source_msg_id
      FROM media_fts
      JOIN media_index m ON m.id = media_fts.rowid
      WHERE media_fts MATCH ?
      ORDER BY media_fts.rank
      LIMIT 15
    `).all(query);

    if (results.length === 0) {
      return ctx.reply('❌ No results found. Try a different title.');
    }

    const groups = new Map();
    for (const r of results) {
      const key = `${r.title}|${r.year || 0}`;
      if (!groups.has(key)) {
        groups.set(key, { title: r.title, year: r.year, items: [] });
      }
      groups.get(key).items.push(r);
    }

    const keyboard = new InlineKeyboard();
    for (const [_, g] of groups) {
      const label = g.year ? `${g.title} (${g.year})` : g.title;
      keyboard.text(label, `sel_${g.items[0].id}`).row();
    }
    keyboard.text('❌ Cancel', 'cancel');

    ctx.reply(`📁 **${results.length} result(s) for "${query}":**`, {
      reply_markup: keyboard, parse_mode: 'Markdown',
    });
  });

  // ── Title selected ─────────────────────────────────────
  bot.callbackQuery(/^sel_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const db = getDb();
    const items = db.prepare(`
      SELECT * FROM media_index WHERE id = ? OR title = (
        SELECT title FROM media_index WHERE id = ?
      ) ORDER BY season, episode, file_size
    `).all(id, id);

    if (items.length === 0) return ctx.answerCallbackQuery('Not found.');

    const first = items[0];
    const hasSeasons = items.some(i => i.season != null);

    if (hasSeasons) {
      const seasons = [...new Set(items.map(i => i.season).filter(s => s != null))].sort();
      const keyboard = new InlineKeyboard();
      for (const s of seasons) {
        const eps = items.filter(i => i.season === s);
        keyboard.text(`Season ${s} (${eps.length} eps)`, `season_${s}_${first.id}`).row();
      }
      keyboard.text('📦 Send All Seasons', `sendall_${first.id}`).row();
      keyboard.text('◀ Back', 'back').text('❌ Cancel', 'cancel');
      await ctx.editMessageText(`**${first.title}** — select season:`, {
        reply_markup: keyboard, parse_mode: 'Markdown',
      });
    } else {
      await showVersions(ctx, first.id, items);
    }
    await ctx.answerCallbackQuery();
  });

  // ── Season selected ────────────────────────────────────
  bot.callbackQuery(/^season_(\d+)_(\d+)$/, async (ctx) => {
    const season = Number(ctx.match[1]);
    const id = Number(ctx.match[2]);
    const db = getDb();
    const items = db.prepare(`
      SELECT * FROM media_index
      WHERE title = (SELECT title FROM media_index WHERE id = ?)
        AND season = ?
      ORDER BY episode, file_size
    `).all(id, season);

    if (items.length === 0) return ctx.answerCallbackQuery('No episodes found.');

    const first = items[0];
    const eps = [...new Set(items.map(i => i.episode).filter(e => e != null))].sort();
    const keyboard = new InlineKeyboard();
    for (const e of eps) {
      const versions = items.filter(i => i.episode === e);
      const label = `E${String(e).padStart(2, '0')}`;
      keyboard.text(
        versions.length > 1 ? `${label} (${versions.length})` : label,
        `ep_${e}_${first.id}`
      ).row();
    }
    // Quality-grouped Send All buttons
    const qualityGroups = db.prepare(`
      SELECT DISTINCT resolution, codec FROM media_index
      WHERE title = (SELECT title FROM media_index WHERE id = ?)
        AND season = ?
    `).all(first.id, season);

    for (const q of qualityGroups) {
      const label = ['📦 All', q.resolution, q.codec].filter(Boolean).join(' ').toUpperCase();
      const res = q.resolution || '-';
      const codec = q.codec || '-';
      keyboard.text(label, `sendallq:${first.id}:${season}:${res}:${codec}`).row();
    }

    keyboard.text('◀ Seasons', `titleback_${first.id}`).text('❌ Cancel', 'cancel');
    await ctx.editMessageText(`**${first.title} S${String(season).padStart(2, '0')}** — select episode:`, {
      reply_markup: keyboard, parse_mode: 'Markdown',
    });
    await ctx.answerCallbackQuery();
  });

  // ── Episode selected ───────────────────────────────────
  bot.callbackQuery(/^ep_(\d+)_(\d+)$/, async (ctx) => {
    const episode = Number(ctx.match[1]);
    const id = Number(ctx.match[2]);
    const db = getDb();
    const items = db.prepare(`
      SELECT * FROM media_index
      WHERE title = (SELECT title FROM media_index WHERE id = ?)
        AND episode = ?
      ORDER BY file_size DESC
    `).all(id, episode);

    if (items.length === 0) return ctx.answerCallbackQuery('Not found.');
    await showVersions(ctx, id, items);
    await ctx.answerCallbackQuery();
  });

  // ── Version selected (forward single file) ────────────
  bot.callbackQuery(/^fwd_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const db = getDb();
    const item = db.prepare("SELECT * FROM media_index WHERE id = ?").get(id);
    if (!item) return ctx.answerCallbackQuery('Not found.');

    const targetChatId = ctx.chat.id;
    const isGroup = targetChatId !== ctx.from.id;

    await ctx.editMessageText('⏳ Forwarding...');
    await ctx.answerCallbackQuery();

    try {
      const fileIds = [];
      if (item.package_id && item.total_parts > 1) {
        const parts = db.prepare(
          "SELECT * FROM media_index WHERE package_id = ? ORDER BY part_number"
        ).all(item.package_id);
        for (const p of parts) {
          const sent = await ctx.api.forwardMessage(targetChatId, p.source_chat_id, p.source_msg_id);
          if (isGroup) fileIds.push(sent.message_id);
        }
        await ctx.editMessageText(`✅ Sent ${parts.length} parts.${isGroup ? '. Save video privately — auto-deletes in 30s.' : ''}`);
      } else {
        const sent = await ctx.api.forwardMessage(targetChatId, item.source_chat_id, item.source_msg_id);
        if (isGroup) fileIds.push(sent.message_id);
        await ctx.editMessageText(`✅ Sent!${isGroup ? ' Save video privately — auto-deletes in 30s.' : ''}`);
      }
      if (isGroup && fileIds.length) {
        setTimeout(async () => {
          for (const msgId of fileIds) try { await ctx.api.deleteMessage(targetChatId, msgId); } catch {}
        }, 30_000);
      }
    } catch (err) {
      await ctx.editMessageText(`❌ Failed: ${err.message}`);
    }
  });

  // ── Send all ───────────────────────────────────────────
  bot.callbackQuery(/^sendall_(\d+)(?:_(\d+))?$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const seasonFilter = ctx.match[2] ? Number(ctx.match[2]) : null;
    const db = getDb();

    let items;
    if (seasonFilter) {
      items = db.prepare(`
        SELECT * FROM media_index
        WHERE title = (SELECT title FROM media_index WHERE id = ?)
          AND season = ?
        ORDER BY episode, file_size DESC
      `).all(id, seasonFilter);
    } else {
      items = db.prepare(`
        SELECT * FROM media_index
        WHERE title = (SELECT title FROM media_index WHERE id = ?)
        ORDER BY season, episode, file_size DESC
      `).all(id);
    }

    if (items.length === 0) return ctx.answerCallbackQuery('Nothing to send.');

    const targetChatId = ctx.chat.id;
    const isGroup = targetChatId !== ctx.from.id;

    await ctx.editMessageText(`📤 Forwarding ${items.length} files...`);
    await ctx.answerCallbackQuery();

    let sent = 0; let failed = 0;
    const fileIds = [];
    for (const item of items) {
      try {
        if (item.package_id && item.total_parts > 1) {
          const parts = db.prepare(
            "SELECT * FROM media_index WHERE package_id = ? ORDER BY part_number"
          ).all(item.package_id);
          for (const p of parts) {
            const m = await ctx.api.forwardMessage(targetChatId, p.source_chat_id, p.source_msg_id);
            if (isGroup) fileIds.push(m.message_id);
            await new Promise(r => setTimeout(r, 200));
          }
        } else {
          const m = await ctx.api.forwardMessage(targetChatId, item.source_chat_id, item.source_msg_id);
          if (isGroup) fileIds.push(m.message_id);
        }
        sent++;
      } catch (e) {
        failed++;
      }
      if (sent % 5 === 0) await new Promise(r => setTimeout(r, 1000));
    }

    const errPart = failed > 0 ? ` (${failed} failed)` : '';
    await ctx.editMessageText(`✅ Forwarded ${sent}/${items.length} files${errPart}${isGroup ? '. Save video privately — auto-deletes in 30s.' : ''}`);
    if (isGroup && fileIds.length) {
      setTimeout(async () => {
        for (const msgId of fileIds) try { await ctx.api.deleteMessage(targetChatId, msgId); } catch {}
      }, 30_000);
    }
  });

  // ── Send all by quality ────────────────────────────────
  bot.callbackQuery(/^sendallq:/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split(':');
    const id = Number(parts[1]);
    const season = Number(parts[2]);
    const res = parts[3] === '-' ? null : parts[3];
    const codec = parts[4] === '-' ? null : parts[4];
    const db = getDb();

    let query = `SELECT * FROM media_index WHERE title = (SELECT title FROM media_index WHERE id = ?) AND season = ?`;
    const params = [id, season];
    if (res !== null) { query += ` AND resolution = ?`; params.push(res); }
    if (codec !== null) { query += ` AND codec = ?`; params.push(codec); }
    query += ` ORDER BY episode`;

    const items = db.prepare(query).all(...params);
    if (items.length === 0) return ctx.answerCallbackQuery('Nothing to send.');

    const targetChatId = ctx.chat.id;
    const isGroup = targetChatId !== ctx.from.id;

    await ctx.editMessageText(`📤 Forwarding ${items.length} files...`);
    await ctx.answerCallbackQuery();

    let sent = 0; let failed = 0;
    const fileIds = [];
    for (const item of items) {
      try {
        if (item.package_id && item.total_parts > 1) {
          const parts = db.prepare(
            "SELECT * FROM media_index WHERE package_id = ? ORDER BY part_number"
          ).all(item.package_id);
          for (const p of parts) {
            const m = await ctx.api.forwardMessage(targetChatId, p.source_chat_id, p.source_msg_id);
            if (isGroup) fileIds.push(m.message_id);
            await new Promise(r => setTimeout(r, 200));
          }
        } else {
          const m = await ctx.api.forwardMessage(targetChatId, item.source_chat_id, item.source_msg_id);
          if (isGroup) fileIds.push(m.message_id);
        }
        sent++;
      } catch (e) {
        failed++;
      }
      if (sent % 5 === 0) await new Promise(r => setTimeout(r, 1000));
    }
    const errPart = failed > 0 ? ` (${failed} failed)` : '';
    await ctx.editMessageText(`✅ Forwarded ${sent}/${items.length} files${errPart}${isGroup ? '. Save video privately — auto-deletes in 30s.' : ''}`);
    if (isGroup && fileIds.length) {
      setTimeout(async () => {
        for (const msgId of fileIds) try { await ctx.api.deleteMessage(targetChatId, msgId); } catch {}
      }, 30_000);
    }
  });

  // ── Navigation ─────────────────────────────────────────
  bot.callbackQuery(/^titleback_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const db = getDb();
    const first = db.prepare("SELECT * FROM media_index WHERE id = ?").get(id);
    if (!first) return ctx.answerCallbackQuery('Not found.');

    const items = db.prepare(
      "SELECT * FROM media_index WHERE title = ? ORDER BY season, episode"
    ).all(first.title);

    const seasons = [...new Set(items.map(i => i.season).filter(s => s != null))].sort();
    const keyboard = new InlineKeyboard();
    for (const s of seasons) {
      const eps = items.filter(i => i.season === s);
      keyboard.text(`Season ${s} (${eps.length} eps)`, `season_${s}_${id}`).row();
    }
    keyboard.text('📦 Send All Seasons', `sendall_${id}`).row();
    keyboard.text('❌ Cancel', 'cancel');
    await ctx.editMessageText(`**${first.title}** — select season:`, {
      reply_markup: keyboard, parse_mode: 'Markdown',
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('back', async (ctx) => {
    await ctx.editMessageText('◀ Back. Use `/request <title>` to search again.');
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('cancel', async (ctx) => {
    await ctx.editMessageText('❌ Cancelled.');
    await ctx.answerCallbackQuery();
  });

  // ── Auto-detect: bot added to channel or group ────────
  bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    const chat = ctx.myChatMember.chat;

    // Channel: bot must be admin, save as source
    if (chat.type === 'channel' && status === 'administrator') {
      const db = getDb();
      db.prepare(
        "INSERT OR REPLACE INTO source_groups (chat_id, title, type) VALUES (?, ?, 'channel')"
      ).run(chat.id, chat.title || null);
      sourceChatId = chat.id;
      console.log(`Source channel auto-detected: ${chat.title} (${chat.id})`);
      try { await ctx.api.sendMessage(chat.id, '✅ Cine will index files from this channel.'); } catch {}
      return;
    }

    // Supergroup/group: just log (commands work here, but files come from channel)
    if ((chat.type === 'supergroup' || chat.type === 'group') && ['member', 'administrator'].includes(status)) {
      console.log(`Bot added to group: ${chat.title} (${chat.id})`);
      await ctx.api.sendMessage(
        chat.id,
        '✅ Cine is here. Use `/request <title>` to search files from the linked channel.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Removed: clean up if this was the source channel
    if (status === 'left' || status === 'kicked') {
      const db = getDb();
      const current = db.prepare("SELECT chat_id FROM source_groups WHERE type = 'channel' LIMIT 1").get();
      if (current?.chat_id === chat.id) {
        db.prepare("DELETE FROM source_groups").run();
        sourceChatId = null;
        console.log(`Source channel removed: ${chat.id}`);
      }
    }
  });

  // ── /source ────────────────────────────────────────────
  bot.command('source', async (ctx) => {
    const db = getDb();
    const channel = db.prepare("SELECT * FROM source_groups WHERE type = 'channel' LIMIT 1").get();
    if (!channel) {
      return ctx.reply(
        '❌ No source channel set.\n\n'
        + '1. Add me as **admin** to a Telegram channel\n'
        + '2. I will auto-detect it\n'
        + '3. Or use `/join <channel_id>` manually\n\n'
        + 'I also respond to commands from any group or DM.',
        { parse_mode: 'Markdown' }
      );
    }
    ctx.reply(
      `📁 **Source Channel**\n\n`
      + `Title: ${channel.title || 'Unknown'}\n`
      + `Chat ID: \`${channel.chat_id}\`\n`
      + `Since: ${channel.joined_at || 'Unknown'}\n\n`
      + `Send \`/request <title>\` from any chat to search files.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /cancel ─────────────────────────────────────────
  bot.command('cancel', async (ctx) => {
    ctx.reply('OK.');
  });

  // ── Index helper ────────────────────────────────────────
  async function indexFile(chatId, msgId, file, filename) {
    const db = getDb();
    const exists = db.prepare(
      "SELECT id FROM media_index WHERE source_chat_id = ? AND source_msg_id = ?"
    ).get(chatId, msgId);
    if (exists) return;

    const { parseFilename } = await import('../parser/index.js');
    const parsed = parseFilename(filename);
    if (!parsed) return;

    db.prepare(`
      INSERT OR IGNORE INTO media_index
        (title, year, season, episode, resolution, source, codec,
         audio, channels, language, release_group, file_type,
         package_id, part_number, file_size,
         source_chat_id, source_msg_id, raw_filename)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.title, parsed.year || null, parsed.season || null, parsed.episode || null,
      parsed.resolution || null, parsed.source || null, parsed.codec || null,
      parsed.audio || null, parsed.channels || null, parsed.language || null,
      parsed.group || null, parsed.file_type, parsed.package_id || null,
      parsed.part_number || null, file.file_size || 0,
      chatId, msgId, filename
    );
    console.log(`Indexed: ${filename}`);
  }

  // ── New-message indexing: channel posts ────────────────
  bot.on('channel_post', async (ctx) => {
    const msg = ctx.channelPost;
    if (!sourceChatId || ctx.chat.id !== sourceChatId) return;

    const file = msg.document || msg.video || msg.audio;
    if (!file) return;

    const filename = file.file_name;
    if (!filename) return;

    await indexFile(ctx.chat.id, msg.message_id, file, filename);
  });

  // ── New-message indexing: supergroup messages (legacy) ──
  bot.on('message', async (ctx) => {
    const msg = ctx.message;
    if (!sourceChatId || ctx.chat.id !== sourceChatId) return;

    const file = msg.document || msg.video || msg.audio;
    if (!file) return;

    const filename = file.file_name;
    if (!filename) return;

    await indexFile(ctx.chat.id, msg.message_id, file, filename);
  });

  // ── Start ──────────────────────────────────────────────
  console.log('Bot started. Polling...');
  bot.start();
}

// ── Helper: show version selection ─────────────────────────
async function showVersions(ctx, id, items) {
  const first = items[0];
  const keyboard = new InlineKeyboard();

  const seen = new Set();
  const deduped = items.filter(i => {
    const key = `${i.resolution}|${i.codec}|${i.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const v of deduped) {
    const size = v.file_size ? ` (${formatSize(v.file_size)})` : '';
    const label = [v.resolution, v.source, v.codec, v.audio].filter(Boolean).join(' ').toUpperCase();
    keyboard.text(`${label}${size}`, `fwd_${v.id}`).row();
  }

  keyboard.text('📦 Send All', `sendall_${first.id}`).row();
  keyboard.text('❌ Cancel', 'cancel');

  const header = first.season
    ? `**${first.title} S${String(first.season).padStart(2, '0')}${first.episode ? 'E' + String(first.episode).padStart(2, '0') : ''}**`
    : `**${first.title}${first.year ? ` (${first.year})` : ''}**`;

  await ctx.editMessageText(`${header} — choose version:`, {
    reply_markup: keyboard, parse_mode: 'Markdown',
  });
}

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(1)} ${units[i]}`;
}
