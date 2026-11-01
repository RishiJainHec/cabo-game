'use strict';
// Builds cabo-offline.html: the whole game in one file you can send to anyone. It runs
// you-vs-3-bots entirely in the browser (no server), reusing the real engine, bots and rooms.
//   node build-offline.js
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const script = (code) => `<script>\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`;

// Tiny CommonJS shim so engine.js / bot.js / rooms.js run unchanged in the browser.
const runtime = `
(function () {
  const mods = {};
  // Node's crypto.randomInt / randomBytes, backed by the browser's secure random generator.
  const rnd32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
  const cryptoShim = {
    randomInt(n) { const lim = Math.floor(0x100000000 / n) * n; let x; do x = rnd32(); while (x >= lim); return x % n; },
    randomBytes(n) { const b = crypto.getRandomValues(new Uint8Array(n)); return { toString: () => [...b].map((v) => v.toString(16).padStart(2, '0')).join('') }; },
  };
  window.__define = function (name, fn) {
    const module = { exports: {} };
    fn(module, module.exports, (dep) => (dep === 'crypto' ? cryptoShim : mods[dep.replace('./', '')]));
    mods[name] = module.exports;
  };
  window.__mods = mods;
})();`;

const mod = (name) => `__define('${name}', function (module, exports, require) {\n${read(name + '.js')}\n});`;

// An in-page "server": each connection is a pair of fake sockets talking through setTimeout.
const transport = `
window.CABO_OFFLINE = {
  connect() {
    const rooms = __mods.rooms;
    const client = { readyState: 0, send(str) { setTimeout(() => rooms.onMessage(server, str)); }, close() {} };
    const server = { readyState: 1, send(str) { setTimeout(() => client.onmessage && client.onmessage({ data: str })); }, close() {} };
    setTimeout(() => { client.readyState = 1; client.onopen && client.onopen(); });
    return client;
  },
};`;

const ui = 'public/';
let html = read(ui + 'index.html');
html = html.replace('<link rel="stylesheet" href="style.css">', `<style>\n${read(ui + 'style.css')}\n</style>`);
html = html.replace('<script src="app.js"></script>\n<script src="demo.js"></script>', [
  script(runtime), script(mod('engine')), script(mod('bot')), script(mod('rooms')), script(transport),
  script(read(ui + 'app.js')), script(read(ui + 'demo.js')),
].join('\n'));
if (html.includes('src="app.js"') || html.includes('href="style.css"')) throw new Error('index.html changed: update build-offline.js');

const out = path.join(__dirname, 'cabo-offline.html');
fs.writeFileSync(out, html);
console.log(`Wrote ${out} (${Math.round(html.length / 1024)} KB)`);
