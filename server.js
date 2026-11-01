'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { onMessage, onClose, sweep } = require('./rooms');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

// This machine's addresses on the local network, so invite links work for friends on the same Wi-Fi.
const lanAddresses = () => Object.values(os.networkInterfaces()).flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);

// ---------- static files ----------
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  if (url.pathname === '/lan.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify({ ips: lanAddresses(), port: PORT }));
  }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  const reply = (f, data) => {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  };
  fs.readFile(file, (err, data) => {
    if (!err) return reply(file, data);
    // SPA fallback so invite links like /?room=ABCD work
    const index = path.join(PUBLIC, 'index.html');
    fs.readFile(index, (err2, html) => {
      if (err2) { res.writeHead(404); return res.end(); }
      reply(index, html);
    });
  });
});
server.on('clientError', (e, socket) => { try { socket.destroy(); } catch {} });

// ---------- sockets ----------
const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('error', (e) => console.error('ws server:', e.message));
wss.on('connection', (ws) => {
  ws.alive = true;
  ws.budget = { t: Date.now(), n: 0 };
  // a bad frame from one client must only drop that client, never the server
  ws.on('error', () => { try { ws.terminate(); } catch {} });
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    // at most 40 messages a second per tab; real play is far below that
    const now = Date.now();
    if (now - ws.budget.t > 1000) ws.budget = { t: now, n: 0 };
    if (++ws.budget.n > 40) return;
    onMessage(ws, raw);
  });
  ws.on('close', () => onClose(ws));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
  sweep();
}, 20000);

// last resort: log and keep serving every other room rather than exit
process.on('uncaughtException', (e) => console.error('uncaught:', e));

server.listen(PORT, () => {
  console.log(`\n  🃏  CABO is running!\n\n  On this computer:   http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Same Wi-Fi:         http://${ip}:${PORT}`);
  console.log('');
});
