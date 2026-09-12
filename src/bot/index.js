import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { initScan } from '../init-scan.js';

let bot;
let botUsername = '';
let initScanRunning = false;
let ownerStatusNotifiedOffline = false;
const EPISODES_PER_PAGE = 10;
const ANIME_RANGE_CHUNK = 50;
const BULK_CONFIRM_THRESHOLD = 10;
const REQUEST_UI_TTL_MS = 15 * 60 * 1000;
const MIN_AUTO_DELETE_MS = 5 * 60 * 1000;
const MAX_AUTO_DELETE_MS = 7 * 60 * 1000;
const interactiveMessages = new Map();
const inflightRequests = new Set();
const pendingTitlePrompt = new Set();
// Owner fetch option stash: pendingId -> ranked torrent candidates
const fetchOptionCache = new Map();

function mainKeyboard() {
  return new Keyboard()
    .text('🔎 Search').text('🎬 Browse').row()
    .text('⭐ Trending').text('❓ Help').row()
    .resized();
}
let dumpRunning = false;
let dumpScheduleTimeout = null;

export async function startBot() {
  const db = getDb();

  const sources = getSourceGroups(db);
  if (sources.length > 0) {
    console.log(`Source chats restored: ${sources.map((source) => source.title || source.chat_id).join(', ')}`);
  }

  scheduleNextDump();

  bot = process.env.BOT_API_BASE_URL
    ? new Bot(config.botToken, { client: { baseURL: process.env.BOT_API_BASE_URL } })
    : new Bot(config.botToken);
  try {
    const me = await bot.api.getMe();
    botUsername = me.username || '';
  } catch {}

  await registerBotCommands(bot);
  registerShutdownNotifications(bot);

  bot.use(async (ctx, next) => {
    attachResponseLogging(ctx);
    logIncomingUpdate(ctx);

    if (ctx.callbackQuery && !canUseInteractiveMessage(ctx)) {
      await ctx.answerCallbackQuery('this is not your request');
      return;
    }

    if (ctx.callbackQuery) {
      refreshInteractiveMessage(ctx);
    }

    try {
      await next();
    } catch (err) {
      logBotError(ctx, err);
      throw err;
    }
  });

  bot.command('start', (ctx) => {
    const isPrivate = ctx.chat?.type === 'private';
    const isOwner = ctx.from?.id === config.ownerUserId;

    if (!isPrivate) {
      return ctx.reply(
        '🎬 **Cine is ready in this group.**\n\n'
        + '`/search <title>` — or just type the title in my DM\n'
        + (botUsername ? `You can also use me inline: \`@${botUsername} <title>\` in any chat\n` : '')
        + '`/cancel` — cancel the current action',
        { parse_mode: 'Markdown' }
      );
    }

    const baseMessage =
      '👋 Welcome to **Cine**!\n\n'
      + 'Just **type a movie or series title** to search — no commands needed.\n'
      + '`/search <title>` works too.\n'
      + '`/cancel` — cancel the current action\n'
      + '`/help` — how to use Cine';

    if (!isOwner) {
      return ensureDmAccess(ctx, async () => {
        await ctx.reply(baseMessage, { parse_mode: 'Markdown', reply_markup: mainKeyboard() });
      });
    }

    ctx.reply(
      `${baseMessage}\n`
      + '`/myid` — get your user ID\n'
      + '`/source` — show saved source chats\n'
      + '`/join <id/link>` — add a source chat\n'
      + '`/required` — show required channel gate\n'
      + '`/setrequired <id> <link>` — set required channel gate\n'
      + '`/clearrequired` — clear required channel gate\n'
      + '`/initscan` — run the backfill command locally',
      { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
    );
  });

  bot.command('myid', (ctx) => {
    ctx.reply(`Your user ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
  });

  bot.command('help', (ctx) => {
    const inlineLine = botUsername ? `\n• Inline anywhere: \`@${botUsername} bleach\`` : '';
    return ctx.reply(
      '❓ **How to use Cine**\n\n'
      + '• Just **type a title** in this DM — e.g. `bleach`\n'
      + '• Or `/search bleach`' + inlineLine + '\n'
      + '• Pick the title, then season → episode → quality\n'
      + '• Long anime (One Piece, Bleach, Naruto): pick an **episode range** like `E1–E50` or `Latest 20`\n'
      + '• Ranges over 10 files ask for confirmation first\n'
      + '• Files are always delivered **to this DM** and auto-delete in ~5–7 min — save them to Saved Messages\n'
      + '• `/cancel` — close the current menu',
      { parse_mode: 'Markdown' }
    );
  });

  bot.hears('🔎 Search', (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    pendingTitlePrompt.add(ctx.from.id);
    return ctx.reply('What are you looking for? Send the movie or series title.');
  });

  bot.hears('🎬 Browse', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const keyboard = new InlineKeyboard();
    keyboard.text('📺 Anime', 'browse_anime').row();
    keyboard.text('🎬 Movies', 'browse_movies').row();
    keyboard.text('📼 Series', 'browse_series').row();
    keyboard.text('❌ Cancel', 'cancel');
    await ctx.reply('**Browse** — pick a shelf:', { reply_markup: keyboard, parse_mode: 'Markdown' });
  });

  bot.hears('⭐ Trending', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    await sendTrending(ctx);
  });

  bot.hears('❓ Help', (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    return ctx.reply('Tap /help for the full guide.');
  });

  bot.command('initscan', async (ctx) => {
    if (ctx.chat?.type !== 'private' || ctx.from.id !== config.ownerUserId) {
      return ctx.reply('⛔ This command is only available in the owner DM.');
    }

    if (!process.env.API_ID || !process.env.API_HASH || !process.env.SESSION_STRING) {
      return ctx.reply(
        '❌ `API_ID`, `API_HASH`, or `SESSION_STRING` is not set in `.env`.',
        { parse_mode: 'Markdown' }
      );
    }

    if (initScanRunning) {
      return ctx.reply('⏳ A backfill is already running.');
    }

    initScanRunning = true;
    await ctx.reply('📥 Starting backfill for all saved source chats...', { parse_mode: 'Markdown' });

    try {
      const result = await initScan();
      const summary = formatInitScanSummary(result);
      await ctx.reply(
        `✅ Backfill complete.\n\n${summary}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ Backfill failed: ${err.message}`, { parse_mode: 'Markdown' });
    } finally {
      initScanRunning = false;
    }
  });

  bot.command('required', async (ctx) => {
    if (ctx.chat?.type !== 'private' || ctx.from.id !== config.ownerUserId) {
      return ctx.reply('⛔ This command is only available in the owner DM.');
    }

    const setting = getRequiredChannelSetting(getDb());
    if (!setting.id && !setting.link) {
      return ctx.reply('No required channel is configured.');
    }

    await ctx.reply(
      `Required channel:\n`
      + `ID: \`${setting.id || 'not set'}\`\n`
      + `Link: ${setting.link || 'not set'}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('setrequired', async (ctx) => {
    if (ctx.chat?.type !== 'private' || ctx.from.id !== config.ownerUserId) {
      return ctx.reply('⛔ This command is only available in the owner DM.');
    }

    const input = ctx.match?.trim() || '';
    const [rawId, rawLink] = input.split(/\s+/, 2);
    const channelId = Number(rawId);
    if (!channelId || !rawLink) {
      return ctx.reply(
        'Usage:\n`/setrequired -1001234567890 https://t.me/channelusername`',
        { parse_mode: 'Markdown' }
      );
    }

    saveRequiredChannelSetting(getDb(), channelId, rawLink);
    await ctx.reply('✅ Required channel updated.', { parse_mode: 'Markdown' });
  });

  bot.command('clearrequired', async (ctx) => {
    if (ctx.chat?.type !== 'private' || ctx.from.id !== config.ownerUserId) {
      return ctx.reply('⛔ This command is only available in the owner DM.');
    }

    clearRequiredChannelSetting(getDb());
    await ctx.reply('✅ Required channel cleared.', { parse_mode: 'Markdown' });
  });

  // ── /join <chat_id> (owner-only, manual override) ──────
  bot.command('join', async (ctx) => {
    if (ctx.from.id !== config.ownerUserId) {
      return ctx.reply('⛔ Only the bot owner can use this command.');
    }
    const input = ctx.match?.trim();
    const chatRef = normalizeChatRef(input);
    if (!chatRef) {
      return ctx.reply(
        'Usage:\n'
        + '`/join -1001234567890`\n'
        + '`/join @channelusername`\n'
        + '`/join https://t.me/channelusername`\n\n'
        + 'Use a public username link or numeric chat ID.',
        { parse_mode: 'Markdown' }
      );
    }
    try {
      const chat = await ctx.api.getChat(chatRef);
      const db = getDb();
      saveSourceGroup(db, chat);
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

  // ── /search (+ legacy /request alias) ───────────────────
  bot.command(['search', 'request'], async (ctx) => {
    const query = ctx.match?.trim();
    if (!query) {
      return ctx.reply('Send `/search <movie or series title>` — or just type the title.', { parse_mode: 'Markdown' });
    }
    await runSearch(ctx, query);
  });

  // ── Plain text in DM = search (no command needed) ─────────
  bot.on('message:text', async (ctx) => {
    if (ctx.message.entities?.some((e) => e.type === 'bot_command')) return;
    if (ctx.chat?.type !== 'private') return;
    if (isSourceChat(getDb(), ctx.chat.id)) return;
    const query = ctx.message.text?.trim();
    if (!query || query.length < 2) return;
    await runSearch(ctx, query);
  });

  async function runSearch(ctx, query) {
    const accessBlocked = await ensureDmAccess(ctx);
    if (accessBlocked) return;

    const db = getDb();
    const results = db.prepare(`
      SELECT m.id, m.title, m.year, m.season, m.episode,
             m.absolute_episode, m.resolution, m.quality_norm, m.codec,
             m.source, m.file_type, m.file_size, m.source_msg_id
      FROM media_fts
      JOIN media_index m ON m.id = media_fts.rowid
      WHERE media_fts MATCH ?
      ORDER BY media_fts.rank
      LIMIT 50
    `).all(query);

    if (results.length === 0) {
      const suggestions = findCloseMatches(db, query);
      if (suggestions.length > 0) {
        const keyboard = new InlineKeyboard();
        for (const suggestion of suggestions) {
          const label = suggestion.year ? `${suggestion.title} (${suggestion.year})` : suggestion.title;
          keyboard.text(label, `sel_${suggestion.id}`).row();
        }
        keyboard.text('❌ Cancel', 'cancel');

        const sent = await ctx.reply(
          `🔎 No exact matches for "${query}".\n\nDid you mean one of these?`,
          { reply_markup: keyboard, parse_mode: 'Markdown' }
        );
        trackInteractiveMessage(sent.chat.id, sent.message_id, ctx.from.id);
        return;
      }
      await handleMiss(ctx, db, query);
      return;
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
    const shown = [...groups.values()].slice(0, 8);
    for (const g of shown) {
      const eps = new Set(g.items.map((i) => i.absolute_episode ?? (i.season != null ? `${i.season}:${i.episode}` : i.episode)).filter((e) => e != null)).size;
      const quals = [...new Set(g.items.map((i) => (i.quality_norm || i.resolution || '').toUpperCase()).filter(Boolean))].slice(0, 2);
      const meta = [eps ? `${eps} ep${eps === 1 ? '' : 's'}` : null, quals.join('/') || null].filter(Boolean).join(' · ');
      const label = `${g.year ? `${g.title} (${g.year})` : g.title}${meta ? ` — ${meta}` : ''}`;
      keyboard.text(label, `sel_${g.items[0].id}`).row();
    }
    if (groups.size > shown.length) {
      keyboard.text(`More (${groups.size - shown.length} hidden) — refine your title`, 'noop').row();
    }
    keyboard.text('❌ Cancel', 'cancel');

    const sent = await ctx.reply(`📁 **${groups.size} title(s) for "${query}":**`, {
      reply_markup: keyboard, parse_mode: 'Markdown',
    });
    trackInteractiveMessage(sent.chat.id, sent.message_id, ctx.from.id);
  }

  // ── Inline mode: @bot <title> in any chat ──────────────
  bot.inlineQuery(async (ctx) => {
    const q = ctx.inlineQuery.query?.trim();
    if (!q) {
      return ctx.answerInlineQuery([], {
        switch_pm_text: 'Type a title to search Cine',
        switch_pm_parameter: 'inline',
      });
    }
    const db = getDb();
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT m.id, m.title, m.year FROM media_fts
        JOIN media_index m ON m.id = media_fts.rowid
        WHERE media_fts MATCH ?
        ORDER BY media_fts.rank
        LIMIT 30
      `).all(q);
    } catch {
      return ctx.answerInlineQuery([]);
    }
    const seen = new Set();
    const articles = [];
    for (const r of rows) {
      const key = `${r.title}|${r.year || 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (articles.length >= 10) break;
      const stats = db.prepare(`
        SELECT COUNT(*) AS n,
               COUNT(DISTINCT COALESCE(absolute_episode, episode)) AS eps,
               MAX(COALESCE(quality_norm, resolution)) AS q
        FROM media_index WHERE title = ?
      `).get(r.title);
      const desc = `${stats.eps || stats.n} episode(s)${r.year ? ` · ${r.year}` : ''}${stats.q ? ` · ${stats.q}` : ''}`;
      articles.push({
        type: 'article',
        id: `sel_${r.id}`,
        title: r.title,
        description: desc,
        input_message_content: {
          message_text: `🎬 **${r.title}**${r.year ? ` (${r.year})` : ''}\n${desc}\n\nTap below to browse:`,
          parse_mode: 'Markdown',
        },
        reply_markup: new InlineKeyboard().text(`📁 Open ${r.title}`, `sel_${r.id}`),
      });
    }
    return ctx.answerInlineQuery(articles, { cache_time: 30 });
  });

  // ── Title selected ─────────────────────────────────────
  bot.callbackQuery(/^sel_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const db = getDb();
    const items = db.prepare(`
      SELECT * FROM media_index WHERE id = ? OR title = (
        SELECT title FROM media_index WHERE id = ?
      ) ORDER BY season, COALESCE(absolute_episode, episode), file_size DESC
    `).all(id, id);

    if (items.length === 0) return ctx.answerCallbackQuery('Not found.');

    const first = items[0];
    try {
      db.prepare("INSERT INTO request_log (title, user_id) VALUES (?, ?)").run(first.title, ctx.from.id);
    } catch {}
    const hasSeasons = items.some(i => i.season != null);
    const isAnimeBulk = !hasSeasons && items.some(i => i.absolute_episode != null) && items.length > 20;

    if (isAnimeBulk) {
      await renderAnimeRangePage(ctx, items);
    } else if (hasSeasons) {
      const seasons = [...new Set(items.map(i => i.season).filter(s => s != null))].sort();
      const keyboard = new InlineKeyboard();
      for (const s of seasons) {
        const eps = items.filter(i => i.season === s);
        keyboard.text(`Season ${s} (${eps.length} eps)`, `season_${s}_${first.id}_0`).row();
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
  bot.callbackQuery(/^season_(\d+)_(\d+)(?:_(\d+))?$/, async (ctx) => {
    const season = Number(ctx.match[1]);
    const id = Number(ctx.match[2]);
    const page = ctx.match[3] ? Number(ctx.match[3]) : 0;
    const db = getDb();
    const items = db.prepare(`
      SELECT * FROM media_index
      WHERE title = (SELECT title FROM media_index WHERE id = ?)
        AND season = ?
      ORDER BY episode, file_size
    `).all(id, season);

    if (items.length === 0) return ctx.answerCallbackQuery('No episodes found.');

    await renderSeasonEpisodePage(ctx, items, season, page);
    await ctx.answerCallbackQuery();
  });

  // ── Episode selected (season-scoped; legacy ep_<e>_<id> supported) ──
  bot.callbackQuery(/^ep_(?:(\d+)_)?(\d+)_(\d+)$/, async (ctx) => {
    const season = ctx.match[1] != null ? Number(ctx.match[1]) : null;
    const episode = Number(ctx.match[2]);
    const id = Number(ctx.match[3]);
    const db = getDb();
    let items;
    if (season != null) {
      items = db.prepare(`
        SELECT * FROM media_index
        WHERE title = (SELECT title FROM media_index WHERE id = ?)
          AND season = ? AND episode = ?
        ORDER BY file_size DESC
      `).all(id, season, episode);
    } else {
      items = db.prepare(`
        SELECT * FROM media_index
        WHERE title = (SELECT title FROM media_index WHERE id = ?)
          AND episode = ?
        ORDER BY file_size DESC
      `).all(id, episode);
    }

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

    await ctx.editMessageText('⏳ Forwarding...');
    await ctx.answerCallbackQuery();
    await forwardItems(ctx, [item]);
  });

  // ── Send all (per-episode deduped; confirm when above threshold) ──
  bot.callbackQuery(/^sendall_(\d+)(?:_(\d+))?$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const seasonFilter = ctx.match[2] ? Number(ctx.match[2]) : null;
    const db = getDb();

    let rows;
    if (seasonFilter) {
      rows = db.prepare(`
        SELECT * FROM media_index
        WHERE title = (SELECT title FROM media_index WHERE id = ?)
          AND season = ?
        ORDER BY episode, file_size DESC
      `).all(id, seasonFilter);
    } else {
      rows = db.prepare(`
        SELECT * FROM media_index
        WHERE title = (SELECT title FROM media_index WHERE id = ?)
        ORDER BY season, COALESCE(absolute_episode, episode), file_size DESC
      `).all(id);
    }

    if (rows.length === 0) return ctx.answerCallbackQuery('Nothing to send.');
    const items = dedupePerEpisode(rows);

    if (items.length > BULK_CONFIRM_THRESHOLD) {
      const keyboard = new InlineKeyboard();
      const scope = seasonFilter ? `sendallcf_${id}_${seasonFilter}` : `sendallcf_${id}`;
      keyboard.text(`✅ Send ${items.length} files`, scope).row();
      keyboard.text('❌ Cancel', 'cancel');
      await ctx.editMessageText(
        `📦 **${items.length} files**${totalSizeLine(items)}\n\nSend them to your DM?`,
        { reply_markup: keyboard, parse_mode: 'Markdown' }
      );
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.editMessageText(`📤 Forwarding ${items.length} files...`);
    await ctx.answerCallbackQuery();
    await forwardItems(ctx, items);
  });

  // ── Bulk confirm ─────────────────────────────────────────
  bot.callbackQuery(/^sendallcf_(\d+)(?:_(\d+))?$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const seasonFilter = ctx.match[2] ? Number(ctx.match[2]) : null;
    const db = getDb();
    const rows = seasonFilter
      ? db.prepare(`SELECT * FROM media_index WHERE title = (SELECT title FROM media_index WHERE id = ?) AND season = ? ORDER BY episode, file_size DESC`).all(id, seasonFilter)
      : db.prepare(`SELECT * FROM media_index WHERE title = (SELECT title FROM media_index WHERE id = ?) ORDER BY season, COALESCE(absolute_episode, episode), file_size DESC`).all(id);
    if (rows.length === 0) return ctx.answerCallbackQuery('Nothing to send.');
    await ctx.editMessageText(`📤 Forwarding ${dedupePerEpisode(rows).length} files...`);
    await ctx.answerCallbackQuery();
    await forwardItems(ctx, dedupePerEpisode(rows));
  });

  // ── Anime range confirm/send ─────────────────────────────
  bot.callbackQuery(/^animerange_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const from = Number(ctx.match[2]);
    const to = Number(ctx.match[3]);
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM media_index
      WHERE title = (SELECT title FROM media_index WHERE id = ?)
        AND COALESCE(absolute_episode, episode) BETWEEN ? AND ?
      ORDER BY COALESCE(absolute_episode, episode), file_size DESC
    `).all(id, from, to);
    if (rows.length === 0) return ctx.answerCallbackQuery('Nothing in this range.');
    const items = dedupePerEpisode(rows);
    if (items.length > BULK_CONFIRM_THRESHOLD) {
      const keyboard = new InlineKeyboard();
      keyboard.text(`✅ Send E${from}–E${to} (${items.length})`, `animesend_${id}_${from}_${to}`).row();
      keyboard.text('❌ Cancel', 'cancel');
      await ctx.editMessageText(`📦 **E${from}–E${to}: ${items.length} files**${totalSizeLine(items)}\n\nSend them to your DM?`,
        { reply_markup: keyboard, parse_mode: 'Markdown' });
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.editMessageText(`📤 Forwarding E${from}–E${to} (${items.length} files)...`);
    await ctx.answerCallbackQuery();
    await forwardItems(ctx, items);
  });

  bot.callbackQuery(/^animesend_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const from = Number(ctx.match[2]);
    const to = Number(ctx.match[3]);
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM media_index
      WHERE title = (SELECT title FROM media_index WHERE id = ?)
        AND COALESCE(absolute_episode, episode) BETWEEN ? AND ?
      ORDER BY COALESCE(absolute_episode, episode), file_size DESC
    `).all(id, from, to);
    if (rows.length === 0) return ctx.answerCallbackQuery('Nothing in this range.');
    await ctx.editMessageText(`📤 Forwarding E${from}–E${to}...`);
    await ctx.answerCallbackQuery();
    await forwardItems(ctx, dedupePerEpisode(rows));
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
    if (res !== null) { query += ` AND LOWER(COALESCE(quality_norm, resolution)) = LOWER(?)`; params.push(res); }
    if (codec !== null) { query += ` AND LOWER(codec) = LOWER(?)`; params.push(codec); }
    query += ` ORDER BY episode, file_size DESC`;

    const rows = db.prepare(query).all(...params);
    if (rows.length === 0) return ctx.answerCallbackQuery('Nothing to send.');
    const items = dedupePerEpisode(rows);

    await ctx.editMessageText(`📤 Forwarding ${items.length} files...`);
    await ctx.answerCallbackQuery();
    await forwardItems(ctx, items);
  });

  // ── Browse shelves ─────────────────────────────────────
  bot.callbackQuery(/^browse_(anime|movies|series)$/, async (ctx) => {
    const shelf = ctx.match[1];
    const db = getDb();
    let rows;
    if (shelf === 'anime') {
      rows = db.prepare(`
        SELECT title, COUNT(*) AS n FROM media_index
        WHERE absolute_episode IS NOT NULL
        GROUP BY title ORDER BY n DESC LIMIT 8
      `).all();
    } else if (shelf === 'movies') {
      rows = db.prepare(`
        SELECT title, year, COUNT(*) AS n FROM media_index
        WHERE season IS NULL AND absolute_episode IS NULL
        GROUP BY title, year ORDER BY n DESC LIMIT 8
      `).all();
    } else {
      rows = db.prepare(`
        SELECT title, COUNT(*) AS n FROM media_index
        WHERE season IS NOT NULL
        GROUP BY title ORDER BY n DESC LIMIT 8
      `).all();
    }
    if (rows.length === 0) return ctx.answerCallbackQuery('Shelf is empty.');
    const keyboard = new InlineKeyboard();
    for (const r of rows) {
      const idRow = db.prepare("SELECT id FROM media_index WHERE title = ? LIMIT 1").get(r.title);
      if (!idRow) continue;
      keyboard.text(`⭐ ${r.title}${r.year ? ` (${r.year})` : ''} · ${r.n}`, `sel_${idRow.id}`).row();
    }
    keyboard.text('❌ Cancel', 'cancel');
    const names = { anime: '📺 Anime', movies: '🎬 Movies', series: '📼 Series' };
    await ctx.editMessageText(`**${names[shelf]}** — top titles:`, {
      reply_markup: keyboard, parse_mode: 'Markdown',
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('trending', async (ctx) => {
    await sendTrending(ctx, true);
    await ctx.answerCallbackQuery();
  });

  // ── Owner fetch: torrent options ───────────────────────
  bot.callbackQuery(/^fetchq_(\d+)$/, async (ctx) => {
    if (ctx.from?.id !== config.ownerUserId) return ctx.answerCallbackQuery('⛔ Owner only.');
    const pendingId = Number(ctx.match[1]);
    const db = getDb();
    const pend = db.prepare('SELECT * FROM pending_requests WHERE id = ?').get(pendingId);
    if (!pend) return ctx.answerCallbackQuery('Request expired.');
    const { debridConfigured } = await import('../fetch/debrid.js');
    if (!debridConfigured()) {
      await ctx.answerCallbackQuery();
      return ctx.editMessageText('❌ `TORBOX_API_KEY` is not set on the server.', { parse_mode: 'Markdown' });
    }
    await ctx.editMessageText(`🌊 Searching torrents for "${pend.query}"...`);
    await ctx.answerCallbackQuery();
    const { searchTorrents, collapseByQuality } = await import('../fetch/sources.js');
    const { checkCached } = await import('../fetch/debrid.js');
    let candidates = [];
    try {
      candidates = await searchTorrents(pend.query);
    } catch (err) {
      return ctx.editMessageText(`❌ Torrent search failed: ${err.message}`);
    }
    if (!candidates.length) {
      return ctx.editMessageText(`❌ No torrents found for "${pend.query}".`);
    }
    const options = collapseByQuality(candidates);
    // Cache flags for top options only (bounded API calls)
    for (const o of options) {
      try {
        o.cached = (await checkCached(o.magnet)).cached;
      } catch { o.cached = false; }
    }
    // Stash options server-side for pick step
    fetchOptionCache.set(pendingId, options);
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < options.length; i++) {
      keyboard.text(fetchOptionLabel(options[i]), `fetchpick_${pendingId}_${i}`).row();
    }
    keyboard.text('❌ Cancel', 'cancel');
    await ctx.editMessageText(
      `🌊 **${pend.query}** — ${options.length} options:`,
      { reply_markup: keyboard, parse_mode: 'Markdown' }
    );
  });

  // ── Owner fetch: confirm one option ──────────────────────
  bot.callbackQuery(/^fetchpick_(\d+)_(\d+)$/, async (ctx) => {
    if (ctx.from?.id !== config.ownerUserId) return ctx.answerCallbackQuery('⛔ Owner only.');
    const pendingId = Number(ctx.match[1]);
    const idx = Number(ctx.match[2]);
    const options = fetchOptionCache.get(pendingId) || [];
    const opt = options[idx];
    if (!opt) return ctx.answerCallbackQuery('Option expired.');
    const db = getDb();
    const pend = db.prepare('SELECT * FROM pending_requests WHERE id = ?').get(pendingId);
    const p = opt.parsed || {};
    const size = opt.size ? ` · ${formatSize(opt.size)}` : '';
    const keyboard = new InlineKeyboard();
    keyboard.text('✅ Fetch & Send', `fetchgo_${pendingId}_${idx}`).row();
    keyboard.text('◀ Options', `fetchq_${pendingId}`).text('❌ Cancel', 'cancel');
    await ctx.editMessageText(
      `📦 **${p.title || opt.name}**${p.year ? ` (${p.year})` : ''}\n`
      + `${opt.cached ? '⚡ Cached — ready in ~1 min' : '⏳ Uncached — queued, slower'}\n`
      + `🎞 ${(p.quality_norm || '?').toUpperCase()} ${(p.source || '')} ${(p.codec || '')}\n`
      + `💾${size} · ${opt.seeders} seeds · by ${p.release_group || opt.source}`,
      { reply_markup: keyboard, parse_mode: 'Markdown' }
    );
    await ctx.answerCallbackQuery();
    void pend;
  });

  // ── Owner fetch: queue + run ─────────────────────────────
  bot.callbackQuery(/^fetchgo_(\d+)_(\d+)$/, async (ctx) => {
    if (ctx.from?.id !== config.ownerUserId) return ctx.answerCallbackQuery('⛔ Owner only.');
    const pendingId = Number(ctx.match[1]);
    const idx = Number(ctx.match[2]);
    const options = fetchOptionCache.get(pendingId) || [];
    const opt = options[idx];
    if (!opt) return ctx.answerCallbackQuery('Option expired.');
    const db = getDb();
    const jobId = db.prepare(`
      INSERT INTO fetch_jobs (query, magnet, torrent_title, torrent_size, seeders, cached, status, requested_by)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
    `).run(
      db.prepare('SELECT query FROM pending_requests WHERE id = ?').get(pendingId)?.query || opt.parsed?.title || 'fetch',
      opt.magnet, opt.name, opt.size || 0, opt.seeders || 0, opt.cached ? 1 : 0, ctx.from.id
    ).lastInsertRowid;
    await ctx.editMessageText(opt.cached ? '📤 Fetching (cached, ~1 min)…' : `⏳ Queued${opt.cached ? '' : ' (uncached, may take a while)'}. I'll ping you on completion.`);
    await ctx.answerCallbackQuery();
    runFetchPipeline(Number(jobId)).catch(async (err) => {
      try {
        db.prepare("UPDATE fetch_jobs SET status = 'failed' WHERE id = ?").run(Number(jobId));
        await ctx.api.sendMessage(config.ownerUserId, `❌ Fetch #${jobId} failed: ${err.message}`);
      } catch {}
    });
  });

  bot.callbackQuery(/^fetchcancel_(\d+)$/, async (ctx) => {
    if (ctx.from?.id !== config.ownerUserId) return ctx.answerCallbackQuery('⛔ Owner only.');
    const db = getDb();
    db.prepare("UPDATE fetch_jobs SET status = 'cancelled' WHERE id = ?").run(Number(ctx.match[1]));
    await ctx.editMessageText('⏹ Fetch cancelled.');
    await ctx.answerCallbackQuery();
  });

  bot.command('queue', async (ctx) => {
    if (ctx.chat?.type !== 'private' || ctx.from.id !== config.ownerUserId) {
      return ctx.reply('⛔ This command is only available in the owner DM.');
    }
    const db = getDb();
    const rows = db.prepare("SELECT * FROM fetch_jobs WHERE status IN ('queued','fetching','ready') ORDER BY id DESC LIMIT 10").all();
    if (!rows.length) return ctx.reply('No active fetch jobs.');
    const keyboard = new InlineKeyboard();
    for (const j of rows) {
      keyboard.text(`❌ #${j.id} ${j.query} (${j.status})`, `fetchcancel_${j.id}`).row();
    }
    await ctx.reply('**Fetch queue:**', { reply_markup: keyboard, parse_mode: 'Markdown' });
  });

  // ── Navigation ─────────────────────────────────────────
  bot.callbackQuery(/^titleback_(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const db = getDb();
    const first = db.prepare("SELECT * FROM media_index WHERE id = ?").get(id);
    if (!first) return ctx.answerCallbackQuery('Not found.');

    const items = db.prepare(
      "SELECT * FROM media_index WHERE title = ? ORDER BY season, COALESCE(absolute_episode, episode)"
    ).all(first.title);

    const hasSeasons = items.some(i => i.season != null);
    if (!hasSeasons && items.length > 20) {
      await renderAnimeRangePage(ctx, items);
      await ctx.answerCallbackQuery();
      return;
    }
    const seasons = [...new Set(items.map(i => i.season).filter(s => s != null))].sort();
    const keyboard = new InlineKeyboard();
    for (const s of seasons) {
      const eps = items.filter(i => i.season === s);
      keyboard.text(`Season ${s} (${eps.length} eps)`, `season_${s}_${id}_0`).row();
    }
    keyboard.text('📦 Send All Seasons', `sendall_${id}`).row();
    keyboard.text('❌ Cancel', 'cancel');
    await ctx.editMessageText(`**${first.title}** — select season:`, {
      reply_markup: keyboard, parse_mode: 'Markdown',
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('back', async (ctx) => {
    await ctx.editMessageText('◀ Back. Use `/search <title>` to search again.');
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('research', async (ctx) => {
    await ctx.editMessageText('🔎 Send me a title — just type it, e.g. `bleach`.', { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('cancel', async (ctx) => {
    await ctx.editMessageText('❌ Cancelled.');
    clearInteractiveMessage(ctx);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('checkjoin', async (ctx) => {
    const allowed = await hasRequiredChannelAccess(ctx);
    if (allowed) {
      await ctx.answerCallbackQuery('access granted');
      try {
        await ctx.editMessageText(
          '✅ Access confirmed.\n\nUse `/request <title>` to search for movies and series.',
          { parse_mode: 'Markdown' }
        );
      } catch {}
      return;
    }

    await ctx.answerCallbackQuery('join the channel first');
  });

  // ── Auto-detect: bot added to channel or group ────────
  bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    const chat = ctx.myChatMember.chat;
    const db = getDb();

    // Track every chat the bot joins
    if (['member', 'administrator'].includes(status)) {
      trackBotChat(db, chat);
    }

    // Channel: bot must be admin, save as source
    if (chat.type === 'channel' && status === 'administrator') {
      saveSourceGroup(db, chat);
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
      untrackBotChat(db, chat.id);
      removeSourceGroup(db, chat.id);
      console.log(`Bot removed from chat: ${chat.id}`);
    }
  });

  // ── /source ────────────────────────────────────────────
  bot.command('source', async (ctx) => {
    const db = getDb();
    const sources = getSourceGroups(db);
    if (sources.length === 0) {
      return ctx.reply(
        '❌ No source chats set.\n\n'
        + '1. Add me as **admin** to a Telegram channel\n'
        + '2. I will auto-detect it\n'
        + '3. Or use `/join <chat_id or t.me link>` manually\n\n'
        + 'I index from every saved source chat.',
        { parse_mode: 'Markdown' }
      );
    }
    const lines = sources.map((source, index) =>
      `${index + 1}. ${source.title || 'Unknown'}\n   ID: \`${source.chat_id}\`\n   Type: ${source.type}\n   Since: ${source.joined_at || 'Unknown'}`
    );
    ctx.reply(
      `📁 **Source Chats**\n\n${lines.join('\n\n')}\n\nSend \`/request <title>\` from any chat to search files.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /cancel ─────────────────────────────────────────
  bot.command('cancel', async (ctx) => {
    ctx.reply('OK.');
  });

  // ── /channels (owner-only) ──────────────────────────────
  bot.command('channels', async (ctx) => {
    if (ctx.chat?.type !== 'private' || ctx.from.id !== config.ownerUserId) {
      return ctx.reply('⛔ This command is only available in the owner DM.');
    }

    const db = getDb();
    const chats = getBotChats(db);
    if (chats.length === 0) {
      return ctx.reply('Not tracking any chats yet. Add me to a channel or group.');
    }

    const lines = chats.map((c, i) =>
      `${i + 1}. ${c.title || 'Untitled'}\n   ID: \`${c.chat_id}\`\n   Type: ${c.type}\n   Since: ${c.added_at || 'Unknown'}`
    );
    ctx.reply(
      `📋 **Bot Chats**\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /setbackup (owner-only) ─────────────────────────────
  bot.command('setbackup', async (ctx) => {
    if (ctx.chat?.type !== 'private' || ctx.from.id !== config.ownerUserId) {
      return ctx.reply('⛔ This command is only available in the owner DM.');
    }

    const input = ctx.match?.trim();
    const chatRef = normalizeChatRef(input);
    if (!chatRef) {
      return ctx.reply(
        'Usage:\n'
        + '`/setbackup -1001234567890`\n'
        + '`/setbackup @channelusername`\n'
        + '`/setbackup https://t.me/channelusername`',
        { parse_mode: 'Markdown' }
      );
    }

    try {
      const chat = await ctx.api.getChat(chatRef);
      const db = getDb();
      saveBackupChannelSetting(db, chat.id);
      ctx.reply(
        `✅ Backup channel set to: ${chat.title || chat.id} (${chat.type})\n\n`
        + 'Now run `/dump` to start backing up files.',
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      ctx.reply(`❌ Failed: ${err.message}`);
    }
  });

  // ── /dump (owner-only) ─────────────────────────────────
  bot.command('dump', async (ctx) => {
    if (ctx.chat?.type !== 'private' || ctx.from.id !== config.ownerUserId) {
      return ctx.reply('⛔ This command is only available in the owner DM.');
    }

    const db = getDb();
    const backupChannelId = getBackupChannelSetting(db);
    if (!backupChannelId) {
      return ctx.reply(
        '❌ No backup channel set.\n\n'
        + 'Use `/setbackup <id/link>` first.',
        { parse_mode: 'Markdown' }
      );
    }

    // Parse interval if provided
    const intervalInput = ctx.match?.trim();
    if (intervalInput && ['off', 'stop', 'none', 'clear'].includes(intervalInput.toLowerCase())) {
      clearDumpSchedule();
      db.prepare("DELETE FROM bot_settings WHERE key = 'dump_interval'").run();
      return ctx.reply('⏹ Scheduled dump cancelled.', { parse_mode: 'Markdown' });
    }

    let intervalMs = 0;
    if (intervalInput) {
      intervalMs = parseDumpInterval(intervalInput);
      if (!intervalMs) {
        return ctx.reply(
          '❌ Invalid interval. Examples: `1w`, `7d`, `3h`, `30m`, `1 week`, `off`',
          { parse_mode: 'Markdown' }
        );
      }
      db.prepare(
        "INSERT INTO bot_settings (key, value) VALUES ('dump_interval', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(String(intervalMs));
    }

    if (dumpRunning) {
      return ctx.reply('⏳ A dump is already running.', { parse_mode: 'Markdown' });
    }

    dumpRunning = true;
    const statusMsg = await ctx.reply('📤 Starting backup...', { parse_mode: 'Markdown' });

    try {
      const result = await runBackup(ctx, statusMsg, backupChannelId);
      const summary = formatDumpSummary(result);

      await bot.api.editMessageText(ctx.chat.id, statusMsg.message_id,
        `✅ Dump complete.\n\n${summary}`,
        { parse_mode: 'Markdown' }
      );

      // Update last_dump_at and schedule next
      db.prepare(
        "INSERT INTO bot_settings (key, value) VALUES ('last_dump_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(new Date().toISOString());

      if (intervalMs > 0) {
        scheduleDumpAfter(intervalMs);
        const label = formatIntervalLabel(intervalMs);
        await bot.api.sendMessage(config.ownerUserId,
          `⏰ Next dump scheduled in ${label}.`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      await bot.api.editMessageText(ctx.chat.id, statusMsg.message_id,
        `❌ Dump failed: ${err.message}`,
        { parse_mode: 'Markdown' }
      );
    } finally {
      dumpRunning = false;
    }
  });

  // ── /retrydump (owner-only) ─────────────────────────────
  bot.command('retrydump', async (ctx) => {
    if (ctx.chat?.type !== 'private' || ctx.from.id !== config.ownerUserId) {
      return ctx.reply('⛔ This command is only available in the owner DM.');
    }

    const db = getDb();
    const count = db.prepare("SELECT COUNT(*) AS c FROM media_index WHERE backup_msg_id = -1").get().c;

    if (count === 0) {
      return ctx.reply('No abandoned files to retry.', { parse_mode: 'Markdown' });
    }

    db.prepare("UPDATE media_index SET backup_msg_id = NULL, backup_retries = 0 WHERE backup_msg_id = -1").run();
    ctx.reply(
      `✅ Reset ${count} abandoned file(s).\n\n`
      + 'Run `/dump` to retry them.',
      { parse_mode: 'Markdown' }
    );
  });

  // ── Index helper ────────────────────────────────────────
  async function indexFile(chatId, msgId, file, filename) {
    const db = getDb();
    const exists = db.prepare(
      "SELECT id FROM media_index WHERE source_chat_id = ? AND source_msg_id = ?"
    ).get(chatId, msgId);
    if (exists) return;

    const duplicate = db.prepare(
      "SELECT id, source_chat_id FROM media_index WHERE raw_filename = ? LIMIT 1"
    ).get(filename);
    if (duplicate) {
      console.log(`Skipped duplicate file from ${chatId}: ${filename}`);
      return;
    }

    const { parseFilename } = await import('../parser/index.js');
    const parsed = parseFilename(filename, { db });
    if (!parsed) {
      try {
        db.prepare(`INSERT OR IGNORE INTO parse_rejects (raw_filename, reason, source_chat_id, source_msg_id)
          VALUES (?, ?, ?, ?)`).run(filename, 'unparsable', chatId, msgId);
      } catch {}
      return;
    }

    db.prepare(`
      INSERT OR IGNORE INTO media_index
        (title, year, season, episode, absolute_episode, episode_end, episode_title,
         resolution, quality_norm, source, codec,
         audio, channels, language, release_group, version, edition, file_type,
         package_id, part_number, file_size,
         source_chat_id, source_msg_id, raw_filename)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizeDbValue(parsed.title),
      normalizeDbValue(parsed.year || null),
      normalizeDbValue(parsed.season ?? null),
      normalizeDbValue(parsed.episode ?? null),
      normalizeDbValue(parsed.absolute_episode ?? null),
      normalizeDbValue(parsed.episode_end ?? null),
      normalizeDbValue(parsed.episode_title || null),
      normalizeDbValue(parsed.resolution || null),
      normalizeDbValue(parsed.quality_norm || null),
      normalizeDbValue(parsed.source || null),
      normalizeDbValue(parsed.codec || null),
      normalizeDbValue(parsed.audio || null),
      normalizeDbValue(parsed.channels || null),
      normalizeDbValue(parsed.language || null),
      normalizeDbValue(parsed.release_group || parsed.group || null),
      normalizeDbValue(parsed.version ?? 1),
      normalizeDbValue(parsed.edition || null),
      normalizeDbValue(parsed.file_type),
      normalizeDbValue(parsed.package_id || null),
      normalizeDbValue(parsed.part_number || null),
      normalizeDbValue(file.file_size || 0),
      normalizeDbValue(chatId),
      normalizeDbValue(msgId),
      normalizeDbValue(filename)
    );
    console.log(`Indexed: ${filename}`);
  }

  // ── New-message indexing: channel posts ────────────────
  bot.on('channel_post', async (ctx) => {
    const msg = ctx.channelPost;
    if (!isSourceChat(getDb(), ctx.chat.id)) return;

    const file = msg.document || msg.video || msg.audio;
    if (!file) return;

    const filename = file.file_name;
    if (!filename) return;

    await indexFile(ctx.chat.id, msg.message_id, file, filename);
  });

  // ── New-message indexing: supergroup messages (legacy) ──
  bot.on('message', async (ctx) => {
    const msg = ctx.message;
    if (!isSourceChat(getDb(), ctx.chat.id)) return;

    const file = msg.document || msg.video || msg.audio;
    if (!file) return;

    const filename = file.file_name;
    if (!filename) return;

    await indexFile(ctx.chat.id, msg.message_id, file, filename);
  });

  // ── Start ──────────────────────────────────────────────
  console.log('Bot started. Polling...');
  await notifyOwnerBotStatus(bot, '✅ bot is active.');
  bot.start();
}

// ── Helper: show version selection ─────────────────────────
async function showVersions(ctx, id, items) {
  const first = items[0];
  const keyboard = new InlineKeyboard();

  const seen = new Set();
  const deduped = items.filter(i => {
    const key = `${(i.quality_norm || i.resolution || '').toLowerCase()}|${(i.codec || '').toLowerCase()}|${(i.source || '').toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const v of deduped) {
    const size = v.file_size ? ` (${formatSize(v.file_size)})` : '';
    const icon = sourceIcon(v.source);
    const label = [v.quality_norm || v.resolution, v.source, v.codec, v.audio].filter(Boolean).join(' ').toUpperCase();
    keyboard.text(`${icon} ${label}${size}`, `fwd_${v.id}`).row();
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

async function renderSeasonEpisodePage(ctx, items, season, page) {
  const first = items[0];
  const eps = [...new Set(items.map((i) => i.episode).filter((e) => e != null))].sort((a, b) => a - b);
  const totalPages = Math.max(1, Math.ceil(eps.length / EPISODES_PER_PAGE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = currentPage * EPISODES_PER_PAGE;
  const pageEpisodes = eps.slice(start, start + EPISODES_PER_PAGE);
  const keyboard = new InlineKeyboard();

  for (const e of pageEpisodes) {
    const versions = items.filter((i) => i.episode === e);
    const label = `E${String(e).padStart(2, '0')}`;
    keyboard.text(
      versions.length > 1 ? `${label} (${versions.length})` : label,
      `ep_${season}_${e}_${first.id}`
    ).row();
  }

  if (totalPages > 1) {
    if (currentPage > 0) {
      keyboard.text('◀ Prev', `season_${season}_${first.id}_${currentPage - 1}`);
    }
    keyboard.text(`Page ${currentPage + 1}/${totalPages}`, 'noop');
    if (currentPage < totalPages - 1) {
      keyboard.text('Next ▶', `season_${season}_${first.id}_${currentPage + 1}`);
    }
    keyboard.row();
  }

  const qualityGroups = getSeasonQualityGroups(first.id, season);
  for (const q of qualityGroups) {
    const label = ['📦 All', q.resolution, q.codec].filter(Boolean).join(' ').toUpperCase();
    const res = q.resolution || '-';
    const codec = q.codec || '-';
    keyboard.text(label, `sendallq:${first.id}:${season}:${res}:${codec}`).row();
  }

  keyboard.text('◀ Seasons', `titleback_${first.id}`).text('❌ Cancel', 'cancel');
  await ctx.editMessageText(
    `**${first.title} S${String(season).padStart(2, '0')}** — choose an episode${totalPages > 1 ? ` (page ${currentPage + 1}/${totalPages})` : ''}:`,
    { reply_markup: keyboard, parse_mode: 'Markdown' }
  );
}

async function forwardItems(ctx, items) {
  const db = getDb();
  // Always deliver to the requester's DM, even when requested from a group.
  const targetChatId = ctx.from.id;
  const inflightKey = `${ctx.from.id}`;
  if (inflightRequests.has(inflightKey)) {
    await ctx.answerCallbackQuery('Already sending — please wait.').catch(() => {});
    return;
  }
  inflightRequests.add(inflightKey);
  try {
    await ensureAutoDeleteTable(db);
    let sent = 0;
    let failed = 0;
    let blocked = false;
    const fileIds = [];

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      try {
        if (item.package_id) {
          const parts = db.prepare(
            "SELECT * FROM media_index WHERE package_id = ? ORDER BY part_number"
          ).all(item.package_id);
          const list = parts.length ? parts : [item];
          for (const p of list) {
            await copyWithRetry(ctx, targetChatId, p, fileIds);
          }
        } else {
          await copyWithRetry(ctx, targetChatId, item, fileIds);
        }
        sent++;
      } catch (err) {
        failed++;
        if (String(err?.message || '').startsWith('bot-blocked')) blocked = true;
        console.log(`[delivery] failed ${item.raw_filename || item.id}: ${err?.message || err}`);
      }

      if ((idx + 1) % 5 === 0 || idx === items.length - 1) {
        await ctx.editMessageText(`📤 Sending ${idx + 1}/${items.length}...`).catch(() => {});
      }
      if ((idx + 1) % 5 === 0) await delay(1000);
    }

    if (sent === 0 && blocked) {
      const link = dmDeepLink();
      const keyboard = new InlineKeyboard();
      if (link) keyboard.url('📩 Open my DM', link).row();
      keyboard.text('🔎 Search again', 'research').row();
      keyboard.text('❌ Cancel', 'cancel');
      await ctx.editMessageText(
        '⚠️ **I can\'t DM you yet.**\n\nTap below to start me, then come back and retry.',
        { reply_markup: keyboard, parse_mode: 'Markdown' }
      ).catch(() => {});
      return;
    }

    const errPart = failed > 0 ? ` (${failed} failed)` : '';
    const deleteDelay = getAutoDeleteDelayMs();
    const dmNote = ctx.chat.id !== targetChatId ? '\n\nSent to your DM.' : '';
    const keyboard = new InlineKeyboard();
    keyboard.text('🔎 Search again', 'research').row();
    keyboard.text('❌ Cancel', 'cancel');
    await ctx.editMessageText(
      `✅ Sent ${sent}/${items.length} files${errPart}. Auto-deletes in about ${formatAutoDeleteMinutes(deleteDelay)} minutes.\n\nSave the files to **Saved Messages** before they are deleted.${dmNote}`,
      { reply_markup: keyboard, parse_mode: 'Markdown' }
    ).catch(() => {});

    if (fileIds.length) {
      const expiresAt = Date.now() + deleteDelay;
      try {
        const stmt = db.prepare("INSERT INTO auto_delete (chat_id, message_id, expires_at) VALUES (?, ?, ?)");
        const ins = db.transaction((ids) => { for (const mid of ids) stmt.run(targetChatId, mid, expiresAt); });
        ins(fileIds);
      } catch {}
      setTimeout(async () => {
        await sweepAutoDelete(ctx, db, targetChatId, fileIds);
      }, deleteDelay);
    }
  } finally {
    inflightRequests.delete(inflightKey);
  }
}

async function copyWithRetry(ctx, targetChatId, item, fileIds, attempt = 0) {
  try {
    const m = await ctx.api.copyMessage(targetChatId, item.source_chat_id, item.source_msg_id);
    fileIds.push(m.message_id);
    return;
  } catch (err) {
    // Fallback to backup copy when the source message is gone.
    if (item.backup_msg_id && item.backup_msg_id > 0 && attempt === 0) {
      try {
        const backupChat = await getBackupChatId(ctx);
        if (backupChat) {
          const m = await ctx.api.copyMessage(targetChatId, backupChat, item.backup_msg_id);
          fileIds.push(m.message_id);
          return;
        }
      } catch {}
    }
    const waitMs = parseFloodWaitMs(err);
    if (waitMs != null && attempt < 3) {
      await delay(waitMs);
      return copyWithRetry(ctx, targetChatId, item, fileIds, attempt + 1);
    }
    if (err?.description === 'bot was blocked by the user' || err?.error_code === 403) {
      throw new Error('bot-blocked: start a DM with the bot first, then retry');
    }
    throw err;
  }
}

function parseFloodWaitMs(err) {
  const raw = err?.parameters?.retry_after ?? err?.retry_after;
  if (raw != null) return (Number(raw) + 1) * 1000;
  const m = String(err?.description || err?.message || '').match(/retry after (\d+)/i);
  return m ? (Number(m[1]) + 1) * 1000 : null;
}

async function getBackupChatId(ctx) {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'backup_channel_id'").get();
    if (row?.value) return Number(row.value);
  } catch {}
  return null;
}

async function ensureAutoDeleteTable(db) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS auto_delete (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    )`);
  } catch {}
}

async function sweepAutoDelete(ctx, db, chatId, fileIds) {
  for (const msgId of fileIds) {
    try { await ctx.api.deleteMessage(chatId, msgId); } catch {}
  }
  try { db.prepare("DELETE FROM auto_delete WHERE chat_id = ?").run(chatId); } catch {}
  try {
    await ctx.api.sendMessage(chatId, '🗑 file has been deleted.');
  } catch {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAutoDeleteDelayMs() {
  return MIN_AUTO_DELETE_MS + Math.floor(Math.random() * (MAX_AUTO_DELETE_MS - MIN_AUTO_DELETE_MS + 1));
}

function formatAutoDeleteMinutes(ms) {
  return (ms / 60_000).toFixed(1);
}

async function ensureDmAccess(ctx, onAllowed) {
  if (ctx.chat?.type !== 'private' || ctx.from?.id === config.ownerUserId) {
    if (onAllowed) await onAllowed();
    return false;
  }

  const allowed = await hasRequiredChannelAccess(ctx);
  if (allowed) {
    if (onAllowed) await onAllowed();
    return false;
  }

  await sendRequiredChannelPrompt(ctx);
  return true;
}

async function hasRequiredChannelAccess(ctx) {
  const setting = getRequiredChannelSetting(getDb());
  if (!setting.id) return true;

  try {
    const member = await ctx.api.getChatMember(setting.id, ctx.from.id);
    return !['left', 'kicked'].includes(member.status);
  } catch {
    return false;
  }
}

async function sendRequiredChannelPrompt(ctx) {
  const setting = getRequiredChannelSetting(getDb());
  const keyboard = new InlineKeyboard();
  if (setting.link) keyboard.url('join channel', setting.link);
  keyboard.text('check again', 'checkjoin');

  await ctx.reply(
    'you need to join the required channel before using cine in dm.',
    { reply_markup: keyboard }
  );
}

function getRequiredChannelSetting(db) {
  const idRow = db.prepare("SELECT value FROM bot_settings WHERE key = 'required_channel_id'").get();
  const linkRow = db.prepare("SELECT value FROM bot_settings WHERE key = 'required_channel_link'").get();

  return {
    id: Number(idRow?.value || config.requiredChannelId || 0),
    link: linkRow?.value || config.requiredChannelLink || '',
  };
}

function saveRequiredChannelSetting(db, channelId, link) {
  const stmt = db.prepare(`
    INSERT INTO bot_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  db.transaction(() => {
    stmt.run('required_channel_id', String(channelId));
    stmt.run('required_channel_link', link);
  })();
}

function clearRequiredChannelSetting(db) {
  db.prepare(
    "DELETE FROM bot_settings WHERE key IN ('required_channel_id', 'required_channel_link')"
  ).run();
}

function trackInteractiveMessage(chatId, messageId, userId) {
  const key = `${chatId}:${messageId}`;
  const existing = interactiveMessages.get(key);
  if (existing?.timeoutId) clearTimeout(existing.timeoutId);

  const timeoutId = setTimeout(async () => {
    try {
      await bot.api.deleteMessage(chatId, messageId);
    } catch {}
    interactiveMessages.delete(key);
  }, REQUEST_UI_TTL_MS);

  interactiveMessages.set(key, { ownerId: userId, timeoutId });
}

function clearInteractiveMessage(ctx) {
  const key = getInteractiveMessageKey(ctx);
  if (!key) return;

  const entry = interactiveMessages.get(key);
  if (entry?.timeoutId) clearTimeout(entry.timeoutId);
  interactiveMessages.delete(key);
}

function canUseInteractiveMessage(ctx) {
  const key = getInteractiveMessageKey(ctx);
  if (!key) return true;

  const entry = interactiveMessages.get(key);
  if (!entry) return true;
  return entry.ownerId === ctx.from?.id;
}

function getInteractiveMessageKey(ctx) {
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (!chatId || !messageId) return null;
  return `${chatId}:${messageId}`;
}

function refreshInteractiveMessage(ctx) {
  const key = getInteractiveMessageKey(ctx);
  if (!key) return;

  const entry = interactiveMessages.get(key);
  if (!entry) return;

  const [chatId, messageId] = key.split(':');
  trackInteractiveMessage(Number(chatId), Number(messageId), entry.ownerId);
}

function getSeasonQualityGroups(id, season) {
  const db = getDb();
  return db.prepare(`
    SELECT DISTINCT COALESCE(quality_norm, resolution) AS resolution, codec FROM media_index
    WHERE title = (SELECT title FROM media_index WHERE id = ?)
      AND season = ?
  `).all(id, season);
}

// One row per episode: input must be pre-sorted with preferred quality first
// (file_size DESC); keeps first occurrence of each season|absolute|episode key.
function dedupePerEpisode(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = `${r.season ?? '-'}|${r.absolute_episode ?? r.episode ?? '-'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function totalSizeLine(items) {
  const bytes = items.reduce((a, i) => a + (i.file_size || 0), 0);
  return bytes ? ` (~${formatSize(bytes)})` : '';
}

// ── Miss handling: log, queue pending, notify owner (24h guard) ──
async function handleMiss(ctx, db, query) {
  const isOwner = ctx.from?.id === config.ownerUserId;
  const normQuery = query.toLowerCase();
  const chatId = ctx.chat.id;
  const isPrivate = ctx.chat?.type === 'private';

  let pendingId = 0;
  try {
    pendingId = Number(db.prepare(`
      INSERT INTO pending_requests (query, user_id, chat_id, chat_title, user_name, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(
      query, ctx.from.id, chatId,
      isPrivate ? null : (ctx.chat.title || null),
      [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || String(ctx.from.id)
    ).lastInsertRowid);
  } catch {}

  if (isOwner) {
    const keyboard = new InlineKeyboard();
    keyboard.text('🌊 Fetch from torrents', `fetchq_${pendingId}`).row();
    keyboard.text('❌ Cancel', 'cancel');
    const sent = await ctx.reply(
      `🔎 No matches for "${query}".\n\nFetch it via torrents?`,
      { reply_markup: keyboard, parse_mode: 'Markdown' }
    );
    trackInteractiveMessage(sent.chat.id, sent.message_id, ctx.from.id);
    return;
  }

  await ctx.reply(
    `❌ "${query}" isn't in the library yet.\n\nThe owner has been notified — you'll get it in your DM if it's fetched.`,
    { parse_mode: 'Markdown' }
  );

  // Notify owner at most once per title+chat per 24h
  try {
    const recent = db.prepare(`
      SELECT id FROM miss_log
      WHERE query = ? AND chat_id = ?
        AND datetime(notified_at) > datetime('now', '-1 day')
      LIMIT 1
    `).get(normQuery, chatId);
    if (recent) return;
    db.prepare("INSERT INTO miss_log (query, chat_id) VALUES (?, ?)").run(normQuery, chatId);
  } catch { return; }

  await notifyOwnerOfMiss(ctx, db, query);
}

async function notifyOwnerOfMiss(ctx, db, query) {
  if (!config.ownerUserId) return;
  let waiting = 0;
  try {
    waiting = db.prepare(`
      SELECT COUNT(DISTINCT user_id) AS c FROM pending_requests
      WHERE LOWER(query) = LOWER(?) AND status = 'pending'
    `).get(query).c;
  } catch {}
  const where = ctx.chat?.type === 'private'
    ? 'in DM'
    : `in ${ctx.chat.title || 'a group'}`;
  const who = ctx.from.username ? `@${ctx.from.username}` : ([ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || String(ctx.from.id));
  const keyboard = new InlineKeyboard();
  const myPending = db.prepare("SELECT id FROM pending_requests WHERE LOWER(query) = LOWER(?) AND user_id = ? AND chat_id = ? ORDER BY id DESC LIMIT 1").get(query, ctx.from.id, ctx.chat.id);
  keyboard.text('🌊 Fetch from torrents', `fetchq_${myPending?.id || 0}`).row();
  keyboard.text('🙈 Dismiss', 'cancel');
  try {
    await ctx.api.sendMessage(
      config.ownerUserId,
      `🔔 **Missed request**\n"${query}" — asked by ${who} ${where}${waiting > 1 ? `\n${waiting} waiting` : ''}`,
      { reply_markup: keyboard, parse_mode: 'Markdown' }
    );
  } catch {}
}

async function sendTrending(ctx, isEdit = false) {
  const db = getDb();
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT title, COUNT(*) AS n FROM request_log
      WHERE datetime(created_at) > datetime('now', '-30 days')
      GROUP BY title ORDER BY n DESC LIMIT 8
    `).all();
  } catch {}
  if (rows.length === 0) {
    rows = db.prepare(`
      SELECT title, COUNT(*) AS n FROM media_index
      GROUP BY title ORDER BY n DESC LIMIT 8
    `).all();
  }
  if (rows.length === 0) {
    const text = '⭐ Nothing trending yet — try a search first.';
    return isEdit ? ctx.editMessageText(text) : ctx.reply(text);
  }
  const keyboard = new InlineKeyboard();
  for (const r of rows) {
    const idRow = db.prepare("SELECT id FROM media_index WHERE title = ? LIMIT 1").get(r.title);
    if (!idRow) continue;
    keyboard.text(`⭐ ${r.title} · ${r.n}`, `sel_${idRow.id}`).row();
  }
  keyboard.text('❌ Cancel', 'cancel');
  const text = '**⭐ Trending** — most requested:';
  return isEdit
    ? ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: 'Markdown' })
    : ctx.reply(text, { reply_markup: keyboard, parse_mode: 'Markdown' });
}

function dmDeepLink() {
  return botUsername ? `https://t.me/${botUsername}?start=dm` : null;
}

function sourceIcon(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('bluray') || s === 'bd') return '💿';
  if (s.includes('web')) return '🌐';
  if (s.includes('hdtv') || s.includes('tv')) return '📺';
  if (s.includes('dvd')) return '📀';
  return '🎬';
}

function fetchOptionLabel(o) {
  const p = o.parsed || {};
  const mark = o.cached ? '⚡' : '⏳';
  const q = (p.quality_norm || '?').toUpperCase();
  const src = p.source || '';
  const codec = p.codec || '';
  const size = o.size ? ` · ${formatSize(o.size)}` : '';
  return `${mark} ${q} ${src} ${codec}${size} · ${o.seeders} seeds`.replace(/\s+/g, ' ').trim();
}

// ── Fetch completion pipeline: debrid -> backup channel -> index -> serve ──
async function runFetchPipeline(jobId) {
  const db = getDb();
  const { addMagnet, torrentStatus, downloadLink } = await import('../fetch/debrid.js');
  const { pickMediaFile, downloadToTemp, ensureFetchTmp, PASSTHROUGH_MAX_BYTES } = await import('../fetch/jobs.js');
  const { parseFilename } = await import('../parser/index.js');
  const { InputFile } = await import('grammy');

  const job = db.prepare('SELECT * FROM fetch_jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error('job vanished');
  const failIfCancelled = () => {
    const s = db.prepare('SELECT status FROM fetch_jobs WHERE id = ?').get(jobId)?.status;
    if (s === 'cancelled') throw new Error('cancelled by owner');
  };

  db.prepare("UPDATE fetch_jobs SET status = 'fetching', updated_at = datetime('now') WHERE id = ?").run(jobId);
  const created = await addMagnet(job.magnet, 1);
  const torboxId = created?.torrent_id || created?.id;
  if (!torboxId) throw new Error('debrid rejected magnet');
  try { db.prepare('UPDATE fetch_jobs SET torbox_id = ? WHERE id = ?').run(torboxId, jobId); } catch {}
  try {
    await bot.api.sendMessage(config.ownerUserId, `⏳ Fetch #${jobId} downloading from swarm…`);
  } catch {}

  // Poll (max ~2h)
  let files = [];
  for (let i = 0; i < 240; i++) {
    failIfCancelled();
    const st = await torrentStatus(torboxId);
    const state = String(st.state || '').toLowerCase();
    if (['completed', 'seeding', 'cached', 'downloaded'].includes(state)) { files = st.files; break; }
    if (['failed', 'error'].includes(state)) throw new Error(`debrid: ${st.state}`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
  if (!files.length) throw new Error('debrid timed out');
  const media = await pickMediaFile(files);
  if (!media) throw new Error('no media file in torrent');
  const url = await downloadLink(torboxId, media.id);

  const backupId = getBackupChannelSetting(db);
  if (!backupId) throw new Error('no backup channel set (/setbackup first)');

  // Post to backup channel: URL passthrough first (zero disk), pipe fallback
  let posted;
  const caption = `${job.query}`;
  if ((media.size || 0) <= PASSTHROUGH_MAX_BYTES) {
    try {
      posted = await bot.api.sendDocument(backupId, new InputFile({ url }), { caption });
    } catch {
      posted = null;
    }
  }
  let tmpPath = null;
  if (!posted) {
    ensureFetchTmp();
    tmpPath = await downloadToTemp(url, media.name);
    try {
      posted = await bot.api.sendDocument(backupId, new InputFile(tmpPath), { caption });
    } finally {
      try { (await import('fs')).unlinkSync(tmpPath); } catch {}
    }
  }
  if (!posted) throw new Error('upload to backup channel failed');

  // Index with known-good metadata (parsed from torrent name)
  const parsed = parseFilename(media.name || job.torrent_title || job.query, { db });
  db.prepare(`
    INSERT OR IGNORE INTO media_index
      (title, year, season, episode, absolute_episode, episode_end, episode_title,
       resolution, quality_norm, source, codec, audio, channels, language,
       release_group, version, edition, file_type, file_size,
       source_chat_id, source_msg_id, raw_filename)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'video', ?, ?, ?, ?)
  `).run(
    parsed?.title || job.query,
    parsed?.year ?? null, parsed?.season ?? null, parsed?.episode ?? null,
    parsed?.absolute_episode ?? null, parsed?.episode_end ?? null, parsed?.episode_title ?? null,
    parsed?.resolution ?? null, parsed?.quality_norm ?? null, parsed?.source ?? null,
    parsed?.codec ?? null, parsed?.audio ?? null, parsed?.channels ?? null,
    parsed?.language ?? null, parsed?.release_group ?? null, parsed?.version ?? 1,
    parsed?.edition ?? null, media.size || 0,
    backupId, posted.message_id, media.name || job.torrent_title || job.query
  );

  db.prepare("UPDATE fetch_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(jobId);

  // Serve all waiting requesters for this query
  const waiting = db.prepare(`
    SELECT DISTINCT user_id, chat_id, chat_title, query FROM pending_requests
    WHERE LOWER(query) = LOWER(?) AND status = 'pending'
  `).all(job.query);
  const row = db.prepare('SELECT * FROM media_index WHERE source_chat_id = ? AND source_msg_id = ?').get(backupId, posted.message_id);
  let delivered = 0;
  const groups = new Map();
  for (const w of waiting) {
    try {
      if (row) {
        await bot.api.copyMessage(w.user_id, backupId, posted.message_id);
        delivered++;
      }
      if (w.chat_id !== w.user_id) {
        if (!groups.has(w.chat_id)) groups.set(w.chat_id, w.chat_title);
      }
    } catch {
      // blocked/deleted — counted as missed
    }
  }
  db.prepare("UPDATE pending_requests SET status = 'served' WHERE LOWER(query) = LOWER(?) AND status = 'pending'").run(job.query);

  const link = botUsername ? `https://t.me/${botUsername}?start=dm` : null;
  for (const [gid, gtitle] of groups) {
    try {
      const kb = new InlineKeyboard();
      if (link) kb.url('📩 Get in DM', link);
      await bot.api.sendMessage(
        gid,
        `✅ "${job.query}" is now available!\nType it here or in my DM to get it.`,
        kb.button ? { reply_markup: kb } : {}
      );
    } catch {}
  }
  try {
    await bot.api.sendMessage(
      config.ownerUserId,
      `✅ Fetch #${jobId} done: "${job.query}" → served ${delivered}/${waiting.length}, announced in ${groups.size} group(s).`
    );
  } catch {}
}

async function renderAnimeRangePage(ctx, items) {
  const first = items[0];
  const nums = [...new Set(items.map((i) => i.absolute_episode ?? i.episode).filter((e) => e != null))].sort((a, b) => a - b);
  if (nums.length === 0) return showVersions(ctx, first.id, items);
  const min = nums[0];
  const max = nums[nums.length - 1];
  const keyboard = new InlineKeyboard();
  for (let s = min; s <= max; s += ANIME_RANGE_CHUNK) {
    const e = Math.min(s + ANIME_RANGE_CHUNK - 1, max);
    keyboard.text(`E${s}–E${e}`, `animerange_${first.id}_${s}_${e}`).row();
  }
  const latest = nums.slice(-20);
  if (nums.length > 20) {
    keyboard.text(`Latest 20 (E${latest[0]}–E${latest[latest.length - 1]})`, `animerange_${first.id}_${latest[0]}_${latest[latest.length - 1]}`).row();
  }
  const quals = [...new Set(items.map((i) => (i.quality_norm || i.resolution || 'Mixed').toUpperCase()))];
  keyboard.text('❌ Cancel', 'cancel');
  await ctx.editMessageText(
    `**${first.title}** — ${nums.length} episodes (E${min}–E${max})\nQuality: ${quals.join(', ')}\n\nPick a range (one file per episode):`,
    { reply_markup: keyboard, parse_mode: 'Markdown' }
  );
}

function formatInitScanSummary(result) {
  const lines = [`Scanned: ${result.groupsScanned} source chat(s)`];

  if (result.totalIndexed > 0) {
    lines.push(`Indexed: ${result.totalIndexed}`);
  } else {
    lines.push('Indexed: 0 (no new files found)');
  }

  if (result.totalSkippedDuplicates > 0) {
    lines.push(`Duplicates skipped: ${result.totalSkippedDuplicates}`);
  }

  return lines.join('\n');
}

function registerShutdownNotifications(bot) {
  const handleShutdown = async (signal) => {
    if (ownerStatusNotifiedOffline) return;
    ownerStatusNotifiedOffline = true;

    try {
      await notifyOwnerBotStatus(bot, `⚠️ bot is offline (${signal}).`);
    } catch {}

    process.exit(0);
  };

  process.once('SIGINT', () => {
    handleShutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    handleShutdown('SIGTERM');
  });
}

async function notifyOwnerBotStatus(bot, text) {
  if (!config.ownerUserId) return;
  await bot.api.sendMessage(config.ownerUserId, text);
}

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(1)} ${units[i]}`;
}

function attachResponseLogging(ctx) {
  const originalReply = ctx.reply.bind(ctx);
  ctx.reply = async (...args) => {
    logOutgoing('reply', ctx, args[0]);
    return originalReply(...args);
  };

  const originalEditMessageText = ctx.editMessageText?.bind(ctx);
  if (originalEditMessageText) {
    ctx.editMessageText = async (...args) => {
      logOutgoing('editMessageText', ctx, args[0]);
      return originalEditMessageText(...args);
    };
  }

  const originalAnswerCallbackQuery = ctx.answerCallbackQuery?.bind(ctx);
  if (originalAnswerCallbackQuery) {
    ctx.answerCallbackQuery = async (...args) => {
      logOutgoing('answerCallbackQuery', ctx, args[0] || '[no text]');
      return originalAnswerCallbackQuery(...args);
    };
  }
}

function logIncomingUpdate(ctx) {
  const chat = formatChat(ctx.chat);
  const user = formatUser(ctx.from);

  if (ctx.message?.text) {
    console.log(`[incoming] message ${chat} ${user} ${truncateText(ctx.message.text)}`);
    return;
  }

  if (ctx.callbackQuery?.data) {
    console.log(`[incoming] callback ${chat} ${user} ${truncateText(ctx.callbackQuery.data)}`);
    return;
  }

  if (ctx.channelPost) {
    const file = ctx.channelPost.document || ctx.channelPost.video || ctx.channelPost.audio;
    const name = file?.file_name || file?.file_id || 'non-file post';
    console.log(`[incoming] channel_post ${chat} ${truncateText(name)}`);
    return;
  }

  if (ctx.myChatMember) {
    console.log(
      `[incoming] my_chat_member ${chat} status=${ctx.myChatMember.new_chat_member.status}`
    );
  }
}

function logOutgoing(type, ctx, payload) {
  console.log(`[outgoing] ${type} ${formatChat(ctx.chat)} ${truncateText(stringifyPayload(payload))}`);
}

function logBotError(ctx, err) {
  console.error(
    `[error] ${formatChat(ctx.chat)} ${formatUser(ctx.from)} ${err?.stack || err?.message || err}`
  );
}

function formatChat(chat) {
  if (!chat) return '[chat unknown]';
  return `[chat ${chat.id}${chat.title ? ` ${chat.title}` : ''}]`;
}

function formatUser(user) {
  if (!user) return '[user unknown]';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return `[user ${user.id}${name ? ` ${name}` : ''}]`;
}

function stringifyPayload(payload) {
  if (typeof payload === 'string') return payload;
  if (payload == null) return '';
  return JSON.stringify(payload);
}

function truncateText(value, max = 160) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
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

function findCloseMatches(db, query) {
  const normalizedQuery = normalizeSearchText(query);
  const candidates = db.prepare(`
    SELECT MIN(id) AS id, title, year
    FROM media_index
    GROUP BY title, year
  `).all();

  return candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreTitleMatch(normalizedQuery, normalizeSearchText(candidate.title)),
    }))
    .filter((candidate) => candidate.score > 0.35)
    .sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)))
    .slice(0, 5);
}

function scoreTitleMatch(query, title) {
  if (!query || !title) return 0;
  if (title.includes(query) || query.includes(title)) return 0.95;

  const queryTokens = new Set(query.split(' ').filter(Boolean));
  const titleTokens = new Set(title.split(' ').filter(Boolean));
  const overlap = [...queryTokens].filter((token) => titleTokens.has(token)).length;
  const tokenScore = overlap / Math.max(queryTokens.size, titleTokens.size, 1);

  const editScore = 1 - levenshteinDistance(query, title) / Math.max(query.length, title.length, 1);
  return Math.max(tokenScore * 0.8 + editScore * 0.2, editScore * 0.75);
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[a.length][b.length];
}

function normalizeChatRef(input) {
  if (!input) return null;

  const trimmed = input.trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);

  const username = extractTelegramUsername(trimmed);
  return username ? `@${username}` : null;
}

function extractTelegramUsername(input) {
  const trimmed = input.trim();

  if (/^@[a-zA-Z0-9_]{5,}$/.test(trimmed)) {
    return trimmed.slice(1);
  }

  const match = trimmed.match(
    /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([a-zA-Z0-9_]{5,})(?:\/)?(?:\?.*)?$/i
  );
  return match ? match[1] : null;
}

async function registerBotCommands(bot) {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'search', description: 'Search for a movie or series' },
    { command: 'help', description: 'How to use Cine' },
    { command: 'cancel', description: 'Cancel the current action' },
  ]);

  await bot.api.setMyCommands(
    [
      { command: 'start', description: 'Start the bot' },
      { command: 'search', description: 'Search for a movie or series' },
      { command: 'help', description: 'How to use Cine' },
      { command: 'cancel', description: 'Cancel the current action' },
      { command: 'source', description: 'Show saved source chats' },
      { command: 'myid', description: 'Show your Telegram user ID' },
      { command: 'join', description: 'Add a source chat by ID or link' },
      { command: 'required', description: 'Show the required channel gate' },
      { command: 'setrequired', description: 'Set required channel ID and link' },
      { command: 'clearrequired', description: 'Clear the required channel gate' },
      { command: 'initscan', description: 'Show the local backfill command' },
      { command: 'channels', description: 'List all chats the bot is in' },
      { command: 'setbackup', description: 'Set backup channel by ID or link' },
      { command: 'dump', description: 'Backup files or set schedule (e.g. /dump 1w)' },
      { command: 'retrydump', description: 'Reset abandoned files for retry' },
    ],
    {
      scope: {
        type: 'chat',
        chat_id: config.ownerUserId,
      },
    }
  );

  console.log('Bot command menu registered.');
}

function getSourceGroups(db) {
  return db.prepare(`
    SELECT *
    FROM source_groups
    ORDER BY type, datetime(joined_at) DESC, rowid DESC
  `).all();
}

function isSourceChat(db, chatId) {
  const row = db.prepare("SELECT 1 FROM source_groups WHERE chat_id = ? LIMIT 1").get(chatId);
  return Boolean(row);
}

function saveSourceGroup(db, chat) {
  const chatType = chat.type === 'channel' ? 'channel' : 'supergroup';

  db.prepare(`
    INSERT OR REPLACE INTO source_groups (chat_id, title, type, joined_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(chat.id, chat.title || null, chatType);
}

function removeSourceGroup(db, chatId) {
  db.prepare("DELETE FROM source_groups WHERE chat_id = ?").run(chatId);
}

// ── Bot chat tracking ─────────────────────────────────────
function trackBotChat(db, chat) {
  db.prepare(`
    INSERT OR REPLACE INTO bot_chats (chat_id, title, type, added_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(chat.id, chat.title || null, chat.type || 'unknown');
}

function untrackBotChat(db, chatId) {
  db.prepare("DELETE FROM bot_chats WHERE chat_id = ?").run(chatId);
}

function getBotChats(db) {
  return db.prepare("SELECT * FROM bot_chats ORDER BY added_at DESC").all();
}

// ── Backup channel settings ───────────────────────────────
function getBackupChannelSetting(db) {
  const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'backup_channel_id'").get();
  return row ? Number(row.value) : 0;
}

function saveBackupChannelSetting(db, chatId) {
  db.prepare(`
    INSERT INTO bot_settings (key, value)
    VALUES ('backup_channel_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(chatId));
}

// ── Dump interval helpers ─────────────────────────────────
function parseDumpInterval(input) {
  if (!input) return 0;
  const str = input.trim().toLowerCase();

  const match = str.match(/^(\d+)\s*(w(?:eeks?)?|d(?:ays?)?|h(?:ours?)?|m(?:in(?:utes?)?)?)$/);
  if (!match) return 0;

  const num = Number(match[1]);
  const unit = match[2][0];

  const multipliers = { w: 7 * 24 * 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, h: 60 * 60 * 1000, m: 60 * 1000 };
  const ms = num * (multipliers[unit] || 0);

  // Minimum 10 minutes
  return Math.max(ms, 10 * 60 * 1000);
}

function formatIntervalLabel(ms) {
  const units = [
    { label: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
    { label: 'day', ms: 24 * 60 * 60 * 1000 },
    { label: 'hour', ms: 60 * 60 * 1000 },
    { label: 'min', ms: 60 * 1000 },
  ];
  for (const u of units) {
    if (ms >= u.ms && ms % u.ms === 0) {
      const val = ms / u.ms;
      return `${val} ${u.label}${val > 1 ? 's' : ''}`;
    }
  }
  return `${Math.round(ms / 60_000)} min`;
}

function clearDumpSchedule() {
  if (dumpScheduleTimeout) {
    clearTimeout(dumpScheduleTimeout);
    dumpScheduleTimeout = null;
  }
}

function scheduleDumpAfter(intervalMs) {
  clearDumpSchedule();
  console.log(`[dump] next scheduled in ${formatIntervalLabel(intervalMs)}`);
  dumpScheduleTimeout = setTimeout(async () => {
    if (dumpRunning) return;

    const db = getDb();
    const backupChannelId = getBackupChannelSetting(db);
    if (!backupChannelId) return;

    // Re-read interval in case it changed
    const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'dump_interval'").get();
    if (!row) return;
    const storedInterval = Number(row.value);
    if (!storedInterval) return;

    dumpRunning = true;
    try {
      // Send status to owner
      const statusMsg = await bot.api.sendMessage(config.ownerUserId, '📤 Running scheduled dump...');
      const result = await runBackup({ api: bot.api, chat: { id: config.ownerUserId } }, statusMsg, backupChannelId);

      await bot.api.editMessageText(config.ownerUserId, statusMsg.message_id,
        `✅ Scheduled dump complete.\n\n${formatDumpSummary(result)}`,
        { parse_mode: 'Markdown' }
      );

      db.prepare(
        "INSERT INTO bot_settings (key, value) VALUES ('last_dump_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(new Date().toISOString());
    } catch (err) {
      try {
        await bot.api.sendMessage(config.ownerUserId,
          `❌ Scheduled dump failed: ${err.message}`,
          { parse_mode: 'Markdown' }
        );
      } catch {}
    } finally {
      dumpRunning = false;
      scheduleDumpAfter(storedInterval);
    }
  }, intervalMs);
}

function scheduleNextDump() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'dump_interval'").get();
  if (!row) return;

  const intervalMs = Number(row.value);
  if (!intervalMs) return;

  const lastRow = db.prepare("SELECT value FROM bot_settings WHERE key = 'last_dump_at'").get();
  const lastDumpAt = lastRow ? new Date(lastRow.value).getTime() : 0;
  const now = Date.now();
  const elapsed = now - lastDumpAt;

  if (elapsed >= intervalMs || !lastDumpAt) {
    if (!lastDumpAt) {
      console.log('[dump] no previous dump found — running now');
    } else {
      console.log(`[dump] overdue by ${formatIntervalLabel(elapsed)} — running now`);
    }
    dumpRunning = true;
    const backupChannelId = getBackupChannelSetting(db);
    if (backupChannelId) {
      (async () => {
        try {
          const statusMsg = await bot.api.sendMessage(config.ownerUserId, '📤 Starting scheduled dump (overdue)...');
          const result = await runBackup({ api: bot.api, chat: { id: config.ownerUserId } }, statusMsg, backupChannelId);

          await bot.api.editMessageText(config.ownerUserId, statusMsg.message_id,
            `✅ Scheduled dump complete.\n\n${formatDumpSummary(result)}`,
            { parse_mode: 'Markdown' }
          );

          db.prepare(
            "INSERT INTO bot_settings (key, value) VALUES ('last_dump_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
          ).run(new Date().toISOString());
        } catch (err) {
          try {
            await bot.api.sendMessage(config.ownerUserId,
              `❌ Scheduled dump failed: ${err.message}`,
              { parse_mode: 'Markdown' }
            );
          } catch {}
        } finally {
          dumpRunning = false;
          scheduleDumpAfter(intervalMs);
        }
      })();
    } else {
      dumpRunning = false;
      scheduleDumpAfter(intervalMs);
    }
  } else {
    // Schedule for remaining time
    const remaining = intervalMs - elapsed;
    console.log(`Next dump in ${formatIntervalLabel(remaining)}`);
    scheduleDumpAfter(remaining);
  }
}

// ── Backup execution ──────────────────────────────────────
async function runBackup(ctx, statusMsg, backupChannelId) {
  const db = getDb();
  const items = db.prepare(`
    SELECT * FROM media_index WHERE backup_msg_id IS NULL ORDER BY id
  `).all();

  if (items.length === 0) {
    console.log('[dump] no files to back up');
    return { copied: 0, failedRetry: 0, failedPermanent: 0, total: 0 };
  }

  let copied = 0;
  let failedRetry = 0;
  let failedPermanent = 0;
  let total = items.length;
  let i = 0;

  while (i < items.length) {
    const item = items[i];
    const check = db.prepare("SELECT backup_msg_id, backup_retries FROM media_index WHERE id = ?").get(item.id);
    if (check && check.backup_msg_id != null) { i++; continue; }

    try {
      const m = await ctx.api.copyMessage(backupChannelId, item.source_chat_id, item.source_msg_id);
      db.prepare("UPDATE media_index SET backup_msg_id = ?, backup_retries = 0 WHERE id = ?").run(m.message_id, item.id);
      copied++;
      i++;
    } catch (err) {
      const retryAfter = parseRetryAfter(err.message);
      if (retryAfter > 0) {
        console.log(`[dump] RATE_LIMITED id=${item.id} waiting ${retryAfter}s`);
        await delay((retryAfter + 1) * 1000);
        continue;
      }

      if (err.message.includes('message to copy not found')) {
        db.prepare("UPDATE media_index SET backup_msg_id = -1 WHERE id = ?").run(item.id);
        failedPermanent++;
        console.log(`[dump] DELETED id=${item.id} title="${item.title}" — abandoning`);
        i++;
        continue;
      }

      const retries = (check?.backup_retries || 0) + 1;
      if (retries >= 3) {
        db.prepare("UPDATE media_index SET backup_msg_id = -1, backup_retries = ? WHERE id = ?").run(retries, item.id);
        failedPermanent++;
        console.log(`[dump] ABANDONED id=${item.id} title="${item.title}" source=(${item.source_chat_id}, ${item.source_msg_id}) attempt=${retries}/3 ${err.message}`);
      } else {
        db.prepare("UPDATE media_index SET backup_retries = ? WHERE id = ?").run(retries, item.id);
        failedRetry++;
        console.log(`[dump] FAILED id=${item.id} title="${item.title}" source=(${item.source_chat_id}, ${item.source_msg_id}) attempt=${retries}/3 ${err.message}`);
      }
      i++;
    }

    const done = copied + failedRetry + failedPermanent;
    if (done % 100 === 0 && done > 0) {
      console.log(`[dump] progress: ${copied}/${total} copied, ${failedRetry} retrying, ${failedPermanent} abandoned`);
    }

    if (done % 5 === 0) {
      await delay(1000);
      try {
        await bot.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          `📤 Backing up... ${done}/${total} files`,
          { parse_mode: 'Markdown' }
        );
      } catch {}
    }
  }

  console.log(`[dump] complete: ${copied} copied, ${failedRetry} will retry, ${failedPermanent} abandoned`);
  return { copied, failedRetry, failedPermanent, total };
}

function parseRetryAfter(message) {
  const match = message.match(/retry after (\d+)/i);
  return match ? Number(match[1]) : 0;
}

function formatDumpSummary(result) {
  const lines = [`Copied: ${result.copied}`];

  const skipped = result.total - result.copied - result.failedRetry - result.failedPermanent;
  if (skipped > 0) lines.push(`Skipped (already backed up): ${skipped}`);
  if (result.failedRetry > 0) lines.push(`Failed (will retry): ${result.failedRetry}`);
  if (result.failedPermanent > 0) lines.push(`Abandoned (3 attempts): ${result.failedPermanent}`);

  return lines.join('\n');
}
