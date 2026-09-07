import { parse } from 'parsium-media';

// Noise prefixes stripped before parsing (kept in raw_filename)
const NOISE_PREFIX_RE = /^(\[REQ\]\s*|ATM\.\s*)+/i;
// Release version: v2, v3 (parsium drops it — extract from raw)
const VERSION_RE = /v(\d)(?![\d])/i;
// Resolution written as dimensions: 1920x1080 -> 1080p
const DIMENSIONS_RE = /(\d{3,4})x(\d{3,4})/i;

export function parseFilename(filename, opts = {}) {
  if (!filename) return null;

  // Step 1: Pre-process
  const cleaned = preprocess(filename);

  // Step 2: Parse with parsium-media (sole parser)
  let parsed;
  try {
    parsed = parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || !parsed.title) return null;
  if (parsed.contentType === 'unknown' && !parsed.seasons?.length && !parsed.episodes?.length && !parsed.absoluteEpisode) {
    return null;
  }

  // Step 3: Map parsium output -> media_index shape
  const result = mapParsium(parsed, filename, opts.db);

  // Step 4: Classify file type
  result.file_type = classifyFileType(filename);
  if (result.file_type === 'zip_split') {
    result.package_id = extractPackageId(filename);
    result.part_number = extractPartNumber(filename);
  }

  return result;
}

function preprocess(filename) {
  return filename.replace(NOISE_PREFIX_RE, '');
}

function mapParsium(p, originalFilename, db) {
  const season = p.seasons?.length ? Number(p.seasons[0]) : null;
  const episode = p.episodes?.length ? Number(p.episodes[0]) : null;
  // Absolute numbering: explicit field when anime-subtype, else fall back
  // to episode number when there is no season (One Piece 1156, Dragon Ball 153).
  const absolute_episode = p.absoluteEpisode != null
    ? Number(p.absoluteEpisode)
    : (season == null && episode != null ? episode : null);
  const lastEp = p.episodes?.length ? Number(p.episodes[p.episodes.length - 1]) : null;
  const episode_end = p.absoluteEpisodeRange?.to != null
    ? Number(p.absoluteEpisodeRange.to)
    : (p.episodeRange?.to != null ? Number(p.episodeRange.to)
      : (lastEp != null && lastEp !== episode ? lastEp : null));

  let title = (p.title || '').trim();
  if (db) title = applyTitleOverrides(db, title);

  return {
    title,
    year: p.year != null ? Number(p.year) : null,
    season,
    episode,
    absolute_episode,
    episode_end,
    episode_title: p.episodeTitle || null,
    resolution: normalizeResolution(p.resolution),
    quality_norm: normalizeResolution(p.resolution),
    source: normalizeSource(p.source),
    codec: normalizeCodec(p.codec),
    audio: Array.isArray(p.audio) ? p.audio.join(', ') : (p.audio || null),
    channels: channelsFromParsium(p),
    language: langFromParsium(p),
    release_group: p.releaseGroup || null,
    version: versionFromRaw(originalFilename),
    edition: editionFromParsium(p),
    content_type: p.contentType || null,
    content_subtype: p.contentSubtype || null,
    file_size: null,
    raw_filename: originalFilename,
  };
}

export function applyTitleOverrides(db, title) {
  if (!title) return title;
  try {
    const exact = db.prepare('SELECT corrected_title FROM title_overrides WHERE match_type = ? AND raw_pattern = ? LIMIT 1')
      .get('exact', title);
    if (exact) return exact.corrected_title;
    const rows = db.prepare("SELECT raw_pattern, corrected_title FROM title_overrides WHERE match_type = 'contains'").all();
    for (const r of rows) {
      if (r.raw_pattern && title.toLowerCase().includes(r.raw_pattern.toLowerCase())) return r.corrected_title;
    }
  } catch {}
  return title;
}

function normalizeResolution(res) {
  if (!res) return null;
  const m = String(res).match(DIMENSIONS_RE);
  if (m) return `${m[2]}p`;
  return String(res).toLowerCase();
}

function normalizeSource(src) {
  if (!src) return null;
  const s = String(src).toLowerCase().replace(/[ _]/g, '');
  if (s === 'bluray' || s === 'blu-ray' || s === 'uhdbluray') return 'BluRay';
  if (s === 'web' || s === 'webdl' || s === 'web-dl') return 'WEB-DL';
  if (s === 'webrip') return 'WEBRip';
  if (s === 'hdtv') return 'HDTV';
  if (s === 'bd' || s === 'bdrip') return 'BluRay';
  if (s === 'dvd' || s === 'dvdrip') return 'DVD';
  return String(src);
}

export function normalizeCodec(codec) {
  if (!codec) return null;
  const c = String(codec).replace(/[ .-]/g, '').toLowerCase();
  if (c === 'h265' || c === 'hevc' || c === 'x265') return 'h265';
  if (c === 'h264' || c === 'avc' || c === 'x264') return 'h264';
  return c;
}

function channelsFromParsium(p) {
  if (Array.isArray(p.channels) && p.channels.length) {
    const m = String(p.channels[0]).match(/[\d.]+/);
    return m ? Number(m[0]) : null;
  }
  return null;
}

function langFromParsium(p) {
  if (Array.isArray(p.languages) && p.languages.length) {
    return p.languages.map((l) => (typeof l === 'string' ? l : (l.label || l.code))).filter(Boolean).join(', ') || null;
  }
  return null;
}

function versionFromRaw(filename) {
  const m = String(filename).match(VERSION_RE);
  return m ? Number(m[1]) : 1;
}

function editionFromParsium(p) {
  const tags = [];
  if (p.isBatchRelease) tags.push('batch');
  if (p.isCompleteSeries) tags.push('complete');
  if (p.isSeasonPack) tags.push('season-pack');
  if (p.isRemux) tags.push('remux');
  if (Array.isArray(p.editions)) tags.push(...p.editions);
  return tags.length ? tags.join(',') : null;
}

function classifyFileType(filename) {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.zip.001') || /\.zip\.\d{3}$/.test(lower)) {
    return 'zip_split';
  }
  if (lower.endsWith('.zip')) {
    return 'zip';
  }
  return 'video';
}

function extractPackageId(filename) {
  return filename.replace(/\.\d{3}$/, '');
}

function extractPartNumber(filename) {
  const match = filename.match(/\.(\d{3})$/);
  return match ? parseInt(match[1], 10) : 0;
}
