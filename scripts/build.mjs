// Packages the extension for both stores:
//   dist/chrome/   + dist/iblock-chrome-<version>.zip    (Chrome Web Store, Edge, Brave, Opera)
//   dist/firefox/  + dist/iblock-firefox-<version>.zip   (addons.mozilla.org)
// No dependencies: the zip writer below is all we need.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

// Firefox runs the background as an event page and wants a stable add-on id.
const firefoxManifest = { ...manifest, background: { scripts: ['shared.js', 'background.js'] } };
delete firefoxManifest.minimum_chrome_version;
firefoxManifest.browser_specific_settings = {
  gecko: {
    id: 'iblock@eraxty',
    strict_min_version: '140.0',
    data_collection_permissions: { required: ['none'] },
  },
};

function listFiles(dir, base = dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
    })
    .sort();
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Fixed timestamp (2026-01-01) so the same source always gives the same zip.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // made by
    header.writeUInt16LE(20, 6); // needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

function build(target, targetManifest) {
  const outDir = path.join(DIST, target);
  fs.rmSync(outDir, { recursive: true, force: true });
  const entries = listFiles(SRC).map((name) => ({
    name,
    data: name === 'manifest.json' ? Buffer.from(`${JSON.stringify(targetManifest, null, 2)}\n`) : fs.readFileSync(path.join(SRC, name)),
  }));
  for (const { name, data } of entries) {
    const dest = path.join(outDir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  const zipPath = path.join(DIST, `iblock-${target}.zip`);
  const archive = zip(entries);
  fs.writeFileSync(zipPath, archive);
  console.log(`${target.padEnd(8)} ${path.relative(ROOT, outDir)}/  ${path.relative(ROOT, zipPath)}  (${entries.length} files)`);
  if (target === 'firefox') {
    // Same archive under the extension Firefox-based browsers install from a file.
    const xpiPath = zipPath.replace(/\.zip$/, '.xpi');
    fs.writeFileSync(xpiPath, archive);
    console.log(`${''.padEnd(8)} ${path.relative(ROOT, xpiPath)}`);
  }
}

fs.mkdirSync(DIST, { recursive: true });
build('chrome', manifest);
build('firefox', firefoxManifest);
