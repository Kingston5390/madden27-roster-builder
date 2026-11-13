// Build RosterBuilder.exe: bundle the CommonJS modules into one script, then wrap it as a Node single-executable app.
// Usage: node build.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = __dirname;
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

// 1. bundle: each local module becomes a function in a tiny registry; local require() calls go through it
const modules = { tdb2: 'lib/tdb2.js', roster: 'lib/roster.js', sync: 'lib/sync.js', league: 'lib/league.js', photos: 'lib/photos.js', draft: 'lib/draft.js',
  franchise: 'lib/franchise.js', college: 'lib/college.js' };
const localReq = src => src.replace(/require\('\.\/(?:lib\/)?(tdb2|roster|sync|league|photos|draft|franchise|college)'\)/g, "__local('$1')");
let out = "'use strict';\nconst __defs = {}, __cache = {};\nfunction __local(n) { if (!__cache[n]) { const module = { exports: {} }; __cache[n] = module; __defs[n](module, module.exports); } return __cache[n].exports; }\n";
for (const [name, file] of Object.entries(modules))
  out += `__defs[${JSON.stringify(name)}] = function (module, exports) {\n${localReq(fs.readFileSync(path.join(root, file), 'utf8'))}\n};\n`;
out += localReq(fs.readFileSync(path.join(root, 'server.js'), 'utf8'));
fs.writeFileSync(path.join(dist, 'app.js'), out);
console.log('bundled dist/app.js');

// 2. single-executable blob. Assets: the UI, the license notices, the college list, and the madden-franchise library (MIT)
// with only the Madden data it reads, which lib/franchise.js unpacks to %APPDATA% on first use
const mf = path.join(root, 'node_modules', 'madden-franchise');
const mfVersion = JSON.parse(fs.readFileSync(path.join(mf, 'package.json'), 'utf8')).version;
const wantVersion = /LIB_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(root, 'lib', 'franchise.js'), 'utf8'))[1];
if (mfVersion !== wantVersion) throw new Error(`node_modules has madden-franchise ${mfVersion} but lib/franchise.js expects ${wantVersion}; run npm install`);
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
// Madden 27 schema; interned strings fall back to 25 and dictionaries to 26, so those ship too
const mfWanted = rel => rel === 'dist/index.cjs' || /^data\/(lookup-files\/|schemas\/extra-schemas\.json$|schemas\/27\/M27_|interned-strings\/(25|26|27)\/|zstd-dicts\/(26|27)\/)/.test(rel);
const assets = { 'index.html': path.join(root, 'ui', 'index.html'), 'THIRD-PARTY-NOTICES.md': path.join(root, 'THIRD-PARTY-NOTICES.md'),
  'colleges.json': path.join(root, 'lib', 'colleges.json') };
for (const rel of walk(mf).map(f => path.relative(mf, f).replace(/\\/g, '/')).filter(mfWanted)) assets[`madden-franchise/${rel}`] = path.join(mf, rel);
const mfFiles = Object.keys(assets).filter(k => k.startsWith('madden-franchise/'));
fs.writeFileSync(path.join(dist, 'mf-manifest.json'), JSON.stringify(mfFiles));
assets['madden-franchise/manifest.json'] = path.join(dist, 'mf-manifest.json');
console.log(`embedding madden-franchise ${mfVersion}: ${mfFiles.length} files`);
const config = {
  main: path.join(dist, 'app.js'), output: path.join(dist, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true, assets,
};
fs.writeFileSync(path.join(dist, 'sea-config.json'), JSON.stringify(config, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(dist, 'sea-config.json')], { stdio: 'inherit' });

// 3. copy node.exe, drop its signature, inject the blob
// node.exe is signed by the Node.js project; injecting the app breaks that signature, so remove it first (what
// `signtool remove /s` does): clear the PE security directory and cut the certificate table off the end of the file
function stripSignature(file) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x4550) throw new Error(`${file} is not a Windows executable`);
  const opt = pe + 24;
  const security = opt + (buf.readUInt16LE(opt) === 0x20b ? 112 : 96) + 4 * 8; // data directory 4 (PE32+ or PE32)
  const at = buf.readUInt32LE(security), size = buf.readUInt32LE(security + 4);
  if (!at) return;
  if (at + size < buf.length - 8) throw new Error('certificate table is not at the end of node.exe; cannot remove it safely');
  buf.writeUInt32LE(0, security); buf.writeUInt32LE(0, security + 4);
  fs.writeFileSync(file, buf.subarray(0, at));
}
const exe = path.join(dist, 'RosterBuilder.exe');
fs.copyFileSync(process.execPath, exe);
if (process.platform === 'win32') stripSignature(exe);
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', config.output,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit', shell: true });

// a windowed program, so no console window opens next to the app (it logs to %APPDATA%\RosterBuilder\log.txt instead).
// `node build.js --console` keeps the console, for debugging.
if (process.platform === 'win32' && !process.argv.includes('--console')) {
  const buf = fs.readFileSync(exe);
  buf.writeUInt16LE(2, buf.readUInt32LE(0x3c) + 24 + 68); // optional header Subsystem: 2 = Windows GUI (was 3, console)
  fs.writeFileSync(exe, buf);
}

// 4. sign it, when a code-signing certificate is set up: SIGN_PFX (a .pfx file) with SIGN_PFX_PASSWORD, or SIGN_THUMBPRINT
// for a certificate in your Windows certificate store. Without one the exe stays unsigned.
if (process.env.SIGN_PFX || process.env.SIGN_THUMBPRINT) {
  const cert = process.env.SIGN_PFX
    ? 'New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($env:SIGN_PFX, $env:SIGN_PFX_PASSWORD)'
    : 'Get-Item "Cert:\\CurrentUser\\My\\$env:SIGN_THUMBPRINT"';
  const script = `$ErrorActionPreference = 'Stop'
$s = Set-AuthenticodeSignature -FilePath $env:SIGN_FILE -Certificate (${cert}) -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
if (-not $s.SignerCertificate) { throw "signing failed: $($s.StatusMessage)" }
"signed by $($s.SignerCertificate.Subject): $($s.Status)"`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit', env: { ...process.env, SIGN_FILE: exe } });
}
console.log(`built ${exe} (${(fs.statSync(exe).size / 1e6).toFixed(1)} MB)`);
