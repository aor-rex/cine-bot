import { Parser, addDefaults } from 'parse-torrent-title';

const parser = new Parser();
addDefaults(parser);

// Custom handler: case-insensitive channel detection (6CH, 2CH, 8CH)
parser.addHandler('channels', /6[.\s]?ch\b/i, { value: 5.1 });
parser.addHandler('channels', /2[.\s]?ch\b/i, { value: 2.0 });
parser.addHandler('channels', /8[.\s]?ch\b/i, { value: 7.1 });

export function parseFilename(filename) {
  if (!filename) return null;

  // Step 1: Pre-process
  let cleaned = preprocess(filename);

  // Step 2: Parse with parse-torrent-title
  const raw = parser.parse(cleaned);

  // Step 3: Post-process
  const result = postprocess(raw, filename);

  // Step 4: Classify file type
  result.file_type = classifyFileType(filename, result);
  if (result.file_type === 'zip_split') {
    result.package_id = extractPackageId(filename);
    result.part_number = extractPartNumber(filename);
  }

  return result;
}

function preprocess(filename) {
  let name = filename;

  // Remove known noise prefixes
  name = name.replace(/^\[REQ\]\s*/i, '');
  name = name.replace(/^ATM\.\s*/i, '');

  // Strip common archive extensions for better parsing
  // Keep video extension stripping to the parser

  return name;
}

function postprocess(raw, originalFilename) {
  const result = { ...raw };

  // Normalize codec
  if (result.codec) {
    result.codec = result.codec.replace(/[ .-]/g, '').toLowerCase();
    if (result.codec === 'h265' || result.codec === 'hevc') result.codec = 'h265';
    if (result.codec === 'h264' || result.codec === 'avc' || result.codec === 'x264') result.codec = 'h264';
    if (result.codec === 'x265') result.codec = 'h265';
  }

  // Ensure season/episode are integers
  if (result.season != null) result.season = Number(result.season);
  if (result.episode != null) result.episode = Number(result.episode);

  // Store raw filename
  result.raw_filename = originalFilename;

  return result;
}

function classifyFileType(filename, parsed) {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.zip.001') || /\.zip\.\d{3}$/.test(lower)) {
    return 'zip_split';
  }
  if (lower.endsWith('.zip') && !parsed.container) {
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
