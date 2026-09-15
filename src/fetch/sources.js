import { parseFilename } from '../parser/index.js';

const FETCH_TIMEOUT_MS = 10_000;

// Normalized torrent candidate:
// { name, magnet, seeders, size, source }

function withTimeout(ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

function toMagnet(infoHash, name) {
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name || 'fetch')}`;
}

// ── The Pirate Bay (apibay.org, no Cloudflare challenge) ──
async function searchTpb(query) {
  const { signal, done } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`,
      { signal }
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((t) => t?.info_hash && t.info_hash !== '0000000000000000000000000000000000000000' && t?.name)
      .map((t) => ({
        name: t.name,
        magnet: toMagnet(t.info_hash, t.name),
        seeders: Number(t.seeders) || 0,
        size: Number(t.size) || 0,
        source: 'TPB',
      }));
  } catch {
    return [];
  } finally {
    done();
  }
}

// ── Knaben (api.knaben.org torrent search API) ──
async function searchKnaben(query) {
  const { signal, done } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.knaben.org/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search: query, per_page: 25 }),
      signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data) ? data : data?.torrents || data?.results || [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((t) => (t?.infohash || t?.info_hash) && (t?.name || t?.title))
      .map((t) => ({
        name: t.name || t.title,
        magnet: toMagnet(t.infohash || t.info_hash, t.name || t.title),
        seeders: Number(t.seeders) || 0,
        size: Number(t.size || t.length) || 0,
        source: 'Knaben',
      }));
  } catch {
    return [];
  } finally {
    done();
  }
}

// ── Torrentio (torrentio.st Stremio addon): title -> Cinemeta IMDb id ->
//    Torrentio streams. Returns per-file/pack candidates with seeders. ──
async function cinemetaId(query, type) {
  const { signal, done } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(query)}.json`,
      { signal }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.metas?.[0]?.id || null;
  } catch {
    return null;
  } finally {
    done();
  }
}

function parseTorrentioStream(s) {
  const title = s?.title || s?.name || '';
  const lines = String(title).split('\n');
  const filename = (lines[0] || '').trim();
  const seedM = String(title).match(/👤\s*(\d+)/);
  const sizeM = String(title).match(/💾\s*([\d.]+\s*[KMGT]?B)/i);
  return {
    name: filename || s?.infoHash || 'torrentio',
    magnet: s?.infoHash ? toMagnet(s.infoHash, filename) : null,
    seeders: seedM ? Number(seedM[1]) : 0,
    size: sizeM ? parseSizeToBytes(sizeM[1]) : 0,
    source: 'Torrentio',
  };
}

function parseSizeToBytes(s) {
  const m = String(s).match(/([\d.]+)\s*([KMGT]?B)/i);
  if (!m) return 0;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(Number(m[1]) * (mult[m[2].toUpperCase()] || 1));
}

async function searchTorrentio(query) {
  const [movieId, seriesId] = await Promise.all([
    cinemetaId(query, 'movie'),
    cinemetaId(query, 'series'),
  ]);
  const jobs = [];
  if (movieId) jobs.push(['movie', movieId]);
  if (seriesId && seriesId !== movieId) jobs.push(['series', seriesId]);
  const out = [];
  await Promise.all(jobs.map(async ([type, id]) => {
    const { signal, done } = withTimeout(FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`https://torrentio.st/stream/${type}/${id}.json`, { signal });
      if (!res.ok) return;
      const data = await res.json();
      for (const s of data?.streams || []) {
        const c = parseTorrentioStream(s);
        if (c.magnet) out.push(c);
      }
    } catch {
      // degrade silently
    } finally {
      done();
    }
  }));
  return out;
}

export async function searchTorrents(query) {
  const [tpb, knaben, torrentio] = await Promise.all([
    searchTpb(query),
    searchKnaben(query),
    searchTorrentio(query),
  ]);

  const seen = new Set();
  const all = [...torrentio, ...tpb, ...knaben].filter((t) => {
    const key = t.magnet.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Rank: seeders desc, size sanity (drop 0-byte), prefer video extensions
  const ranked = all
    .filter((t) => t.seeders > 0)
    .sort((a, b) => b.seeders - a.seeders)
    .slice(0, 30);

  // Attach parsium parse for display + quality collapse.
  // Full metadata is carried so the options screen can show titles,
  // single-vs-batch badges, and ranges (nothing display-relevant dropped).
  return ranked.map((t) => {
    let parsed = null;
    try {
      parsed = parseFilename(t.name);
    } catch {
      parsed = null;
    }
    return {
      ...t,
      parsed: parsed ? {
        title: parsed.title,
        year: parsed.year,
        season: parsed.season,
        episode: parsed.episode,
        absolute_episode: parsed.absolute_episode,
        episode_end: parsed.episode_end,
        edition: parsed.edition,
        content_type: parsed.content_type,
        quality_norm: parsed.quality_norm,
        source: parsed.source,
        codec: parsed.codec,
        release_group: parsed.release_group,
      } : null,
    };
  });
}

// Collapse to best-per-quality for the options screen (legacy: no title grouping)
export function collapseByQuality(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = (c.parsed?.quality_norm || c.parsed?.resolution || 'unknown').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= 5) break;
  }
  return out;
}

function normTitleText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Identity for grouping: same show/movie/season-pack bucket together,
// different titles or years never merge (Ben 10 2005 vs 2016 stay apart).
function titleIdentity(c) {
  const p = c.parsed;
  if (!p?.title) return `raw:${normTitleText(c.name).slice(0, 40)}`;
  const pack = p.season != null ? `s${p.season}` : (p.absolute_episode ?? p.episode) != null ? 'eps' : 'movie';
  return `${normTitleText(p.title)}|${p.year || 0}|${pack}`;
}

// Fraction of query tokens present in the candidate's title (+year)
function relevanceToQuery(c, queryToks) {
  const p = c.parsed;
  const hay = normTitleText([p?.title, p?.year].filter(Boolean).join(' ')) || normTitleText(c.name);
  const hayToks = new Set(hay.split(' ').filter(Boolean));
  if (!queryToks.length) return 0;
  const hit = queryToks.filter((t) => hayToks.has(t)).length;
  return hit / queryToks.length;
}

// Group candidates by title identity, rank groups by query relevance then
// seeders, collapse best-per-quality within each group. Flat list out, in
// display order, each tagged with _groupTitle/_groupYear/_relevance.
// No display cap here — the caller paginates the full passing set.
export function groupOptionsByTitle(candidates, query, { maxGroups = 20, maxTotal = 100, minRelevance = 0.34 } = {}) {
  const queryToks = normTitleText(query).split(' ').filter((t) => t.length > 1);
  const groups = new Map();
  for (const c of candidates) {
    const key = titleIdentity(c);
    if (!groups.has(key)) groups.set(key, { key, items: [], title: c.parsed?.title || c.name, year: c.parsed?.year ?? null });
    groups.get(key).items.push(c);
  }
  for (const g of groups.values()) {
    g.items.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    g.relevance = Math.max(...g.items.map((c) => relevanceToQuery(c, queryToks)));
    g.topSeeders = g.items[0]?.seeders || 0;
  }
  let ranked = [...groups.values()].sort((a, b) => b.relevance - a.relevance || b.topSeeders - a.topSeeders);
  // Relevance floor drops wrong-title groups — but never drop everything.
  const passing = ranked.filter((g) => g.relevance >= minRelevance);
  if (passing.length) ranked = passing;
  ranked = ranked.slice(0, maxGroups);
  const out = [];
  for (const g of ranked) {
    const seen = new Set();
    for (const c of g.items) {
      const q = (c.parsed?.quality_norm || 'unknown').toLowerCase();
      if (seen.has(q)) continue;
      seen.add(q);
      out.push({ ...c, _groupTitle: g.title, _groupYear: g.year, _relevance: g.relevance });
      if (out.length >= maxTotal) break;
    }
    if (out.length >= maxTotal) break;
  }
  return out;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Single vs batch vs movie badge for option lines + confirm screen.
// short=true gives pager-button-safe forms (S01E05, E01–E12, Complete…).
export function releaseBadge(c, short = false) {
  const p = c.parsed || {};
  const ed = String(p.edition || '').toLowerCase();
  if (ed.includes('complete')) return short ? 'Complete' : '📦 Complete series';
  if (ed.includes('season-pack') || (p.season != null && p.episode == null && p.episode_end == null)) {
    if (short) return p.season != null ? `S${pad2(p.season)} pack` : 'Season pack';
    return p.season != null ? `📦 S${pad2(p.season)} pack` : '📦 Season pack';
  }
  if (ed.includes('batch')) return short ? 'Batch' : '📦 Batch';
  if (p.episode_end != null && (p.episode != null || p.absolute_episode != null)) {
    return `E${p.absolute_episode ?? p.episode}–E${p.episode_end}`;
  }
  if (p.season != null && p.episode != null) return `S${pad2(p.season)}E${pad2(p.episode)}`;
  if (p.season != null) return `S${pad2(p.season)}`;
  const ep = p.absolute_episode ?? p.episode;
  if (ep != null) return short ? `E${ep}` : `📺 E${ep}`;
  if (p.year != null || p.content_type === 'movie') return short ? 'Movie' : '🎬 Movie';
  return short ? '' : '🎬';
}
