import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { getDb } from '../db/index.js';
import { addMagnet, torrentStatus, downloadLink } from './debrid.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FETCH_TMP = join(__dirname, '..', '..', 'data', 'fetch-tmp');

// Above this size we skip URL passthrough and go straight to pipe mode
export const PASSTHROUGH_MAX_BYTES = Number(process.env.FETCH_PASSTHROUGH_MAX || 4 * 1024 ** 3);
const POLL_MS = 30_000;

function setStatus(db, id, status, extra = {}) {
  const sets = ['status = ?', `updated_at = datetime('now')`];
  const params = [status];
  if (extra.torboxId !== undefined) { sets.push('torbox_id = ?'); params.push(extra.torboxId); }
  params.push(id);
  try {
    db.prepare(`UPDATE fetch_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  } catch {}
}

export function ensureFetchTmp() {
  try {
    if (!existsSync(FETCH_TMP)) mkdirSync(FETCH_TMP, { recursive: true });
  } catch {}
  return FETCH_TMP;
}

// Download a URL to temp. Returns absolute path. Caller must delete.
export async function downloadToTemp(url, filename) {
  ensureFetchTmp();
  const safe = String(filename || 'fetch.bin').replace(/[^\w.\-]+/g, '_').slice(0, 120);
  const dest = join(FETCH_TMP, `${Date.now()}_${safe}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(dest);
    res.body.pipeTo(new WritableStream({
      write: (c) => new Promise((res2, rej) => ws.write(Buffer.from(c), (e) => (e ? rej(e) : res2()))),
      close: () => ws.end(resolve),
      abort: reject,
    })).catch(reject);
  });
  return dest;
}

// Poll loop for one job. hooks: { bot, ownerId, onDone(job, result) }
export async function runFetchJob(jobId, hooks = {}) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM fetch_jobs WHERE id = ?').get(jobId);
  if (!job || !job.magnet) throw new Error('job not found');

  setStatus(db, jobId, 'fetching');
  const created = await addMagnet(job.magnet, 1);
  const torboxId = created?.torrent_id || created?.id;
  if (!torboxId) throw new Error('debrid rejected magnet');
  setStatus(db, jobId, 'fetching', { torboxId });

  // Poll until complete (caller may also drive via checkFetchJob)
  for (;;) {
    const st = await torrentStatus(torboxId);
    if (['completed', 'seeding', 'cached', 'downloaded'].includes(String(st.state).toLowerCase())) {
      setStatus(db, jobId, 'ready');
      return { torboxId, files: st.files };
    }
    if (['failed', 'error'].includes(String(st.state).toLowerCase())) {
      setStatus(db, jobId, 'failed');
      throw new Error(`debrid fetch failed: ${st.state}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export async function pickMediaFile(files) {
  const vids = (files || []).filter((f) => /\.(mkv|mp4|avi|webm|mov|wmv|m2ts|ts)$/i.test(f.name || ''));
  const pool = vids.length ? vids : (files || []).filter((f) => !/\.(srt|sub|ass|ssa|nfo|txt|jpg|png)$/i.test(f.name || ''));
  if (!pool.length) return (files || [])[0] || null;
  return pool.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

export async function fetchDownloadUrl(job) {
  const torboxId = job.torbox_id;
  if (!torboxId) throw new Error('no torbox id');
  const st = await torrentStatus(torboxId);
  const file = await pickMediaFile(st.files);
  if (!file) throw new Error('no media file in torrent');
  const url = await downloadLink(torboxId, file.id);
  return { url, file };
}

export function markJob(db, id, status) {
  setStatus(db, id, status);
}
