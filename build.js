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
const modules = { tdb2: 'lib/tdb2.js', roster: 'lib/roster.js', sync: 'lib/sync.js', league: 'lib/league.js', photos: 'lib/photos.js' };
const localReq = src => src.replace(/require\('\.\/(?:lib\/)?(tdb2|roster|sync|league|photos)'\)/g, "__local('$1')");
let out = "'use strict';\nconst __defs = {}, __cache = {};\nfunction __local(n) { if (!__cache[n]) { const module = { exports: {} }; __cache[n] = module; __defs[n](module, module.exports); } return __cache[n].exports; }\n";
for (const [name, file] of Object.entries(modules))
  out += `__defs[${JSON.stringify(name)}] = function (module, exports) {\n${localReq(fs.readFileSync(path.join(root, file), 'utf8'))}\n};\n`;
out += localReq(fs.readFileSync(path.join(root, 'server.js'), 'utf8'));
fs.writeFileSync(path.join(dist, 'app.js'), out);
console.log('bundled dist/app.js');

// 2. single-executable blob with the UI as an asset
const config = {
  main: path.join(dist, 'app.js'), output: path.join(dist, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true, assets: { 'index.html': path.join(root, 'ui', 'index.html') },
};
fs.writeFileSync(path.join(dist, 'sea-config.json'), JSON.stringify(config, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(dist, 'sea-config.json')], { stdio: 'inherit' });

// 3. copy node.exe and inject the blob
const exe = path.join(dist, 'RosterBuilder.exe');
fs.copyFileSync(process.execPath, exe);
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', config.output,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit', shell: true });
console.log(`built ${exe} (${(fs.statSync(exe).size / 1e6).toFixed(1)} MB)`);
