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

  // Attach parsium parse for display + quality collapse
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
        quality_norm: parsed.quality_norm,
        source: parsed.source,
        codec: parsed.codec,
        release_group: parsed.release_group,
      } : null,
    };
  });
}

// Collapse to best-per-quality for the options screen
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
