// TorBox debrid client (https://torbox.app).
// Magnet in -> direct HTTPS out. No torrent traffic on our infra.
// Requires TORBOX_API_KEY in env (owner-funded single key).

const API = 'https://api.torbox.app/v1/api';
const TIMEOUT_MS = 15_000;

function key() {
  return process.env.TORBOX_API_KEY || '';
}

export function debridConfigured() {
  return Boolean(key());
}

async function req(path, { method = 'GET', body } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key()}`,
        ...(body instanceof URLSearchParams ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body,
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      throw new Error(data?.detail || data?.error || `torbox ${res.status}`);
    }
    return data?.data ?? data;
  } finally {
    clearTimeout(t);
  }
}

function hashFromMagnet(magnet) {
  const m = String(magnet).match(/btih:([a-fA-F0-9]{40})/i);
  return m ? m[1].toLowerCase() : null;
}

// Returns { cached: boolean } — best effort, false on any doubt
export async function checkCached(magnet) {
  const hash = hashFromMagnet(magnet);
  if (!hash) return { cached: false };
  try {
    const data = await req(`/torrents/checkcached?hash=${hash}&format=list&list_files=false`);
    const list = Array.isArray(data) ? data : [];
    const hit = list.find((h) => String(h?.hash || '').toLowerCase() === hash);
    return { cached: Boolean(hit) };
  } catch {
    return { cached: false };
  }
}

export async function addMagnet(magnet, seed = 1) {
  const body = new URLSearchParams({ magnet, seed: String(seed), allow_zip: 'false' });
  const data = await req('/torrents/createtorrent', { method: 'POST', body });
  // { torrent_id, ... }
  return data;
}

export async function torrentStatus(torrentId) {
  const data = await req(`/torrents/mylist?id=${torrentId}`);
  const t = Array.isArray(data) ? data[0] : data;
  if (!t) throw new Error('torrent not found');
  return {
    state: t.download_state || t.state,
    progress: Number(t.progress) || 0,
    files: (t.files || []).map((f) => ({
      id: f.id,
      name: f.name || f.short_name,
      size: Number(f.size) || 0,
    })),
  };
}

export async function downloadLink(torrentId, fileId) {
  const data = await req(
    `/torrents/requestdl?torrent_id=${torrentId}&file_id=${fileId}&token=${encodeURIComponent(key())}&redirect=false`
  );
  const url = data?.url || data?.download_url || (typeof data === 'string' ? data : null);
  if (!url) throw new Error('no download link');
  return url;
}
