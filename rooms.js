'use strict';
// Rooms, lobby and message handling. Transport-agnostic: a "socket" is anything with
// send(string), readyState (1 = open) and close(); the real server passes WebSockets,
// the offline single-file build passes an in-page fake.
const crypto = require('crypto');
const { Game } = require('./engine');
const { Bot } = require('./bot');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const MAX_ROOMS = 2000;
const LEVELS = ['easy', 'medium', 'hard'];
// A human who owes a move and doesn't make it gets a stand-in bot for that move.
const AWAY_MS = 10000;  // disconnected
const IDLE_MS = 60000;  // connected but not moving
const HOST_GRACE_MS = 10000; // a host who drops (e.g. reloads) keeps the role this long
const rooms = new Map();
const newId = () => crypto.randomBytes(6).toString('hex');
function newCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let i = 0; i < 50; i++) {
    const c = Array.from({ length: 4 }, () => L[crypto.randomInt(L.length)]).join('');
    if (!rooms.has(c)) return c;
  }
  return null;
}
// letters, numbers, spaces and ordinary punctuation; no control or direction-flipping characters
const str = (x) => (typeof x === 'string' ? x : '');
const cleanName = (n) => str(n).replace(/[<>&"'\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Player';

class Room {
  constructor(code) {
    this.code = code;
    this.players = []; // {id, name, token, ws, ready, isBot}
    this.hostId = null;
    this.mode = 'FF';
    this.level = 'medium'; // bot difficulty
    this.game = null;
    this.bots = [];
    this.standIns = {}; // pid -> Bot making a stuck human's move
    this.idle = null;   // { key, timer } for the move currently owed
    this.touched = Date.now();
  }
  get(id) { return this.players.find((p) => p.id === id); }
  connected(p) { return p.isBot || (p.ws && p.ws.readyState === 1); }

  view(pid) {
    const base = { code: this.code, hostId: this.hostId, mode: this.mode, level: this.level, you: pid };
    if (!this.game) {
      return {
        ...base, status: 'LOBBY', now: Date.now(),
        players: this.players.map((p) => ({ id: p.id, name: p.name, ready: p.ready || p.id === this.hostId, connected: this.connected(p), isBot: p.isBot })),
      };
    }
    return { ...this.game.view(pid), ...base, mode: this.game.mode };
  }

  send(p, obj) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
  broadcast() {
    this.touched = Date.now();
    for (const p of this.players) this.send(p, { type: 'state', view: this.view(p.id) });
    for (const b of this.bots) b.poke();
    this.watchIdle();
  }

  // The host role moves to another connected human when the host has left or been gone a while.
  fixHost(now = false) {
    const h = this.get(this.hostId);
    if (h && (this.connected(h) || (!now && !h.left))) return false;
    const next = this.players.find((x) => !x.isBot && this.connected(x));
    if (!next || next.id === this.hostId) return false;
    this.hostId = next.id;
    next.ready = true;
    return true;
  }

  // Nobody can freeze the game: when it's a human's move (their turn, or the opening peek) and they
  // don't make it, offline for AWAY_MS or idle for IDLE_MS, a stand-in bot makes that move for them.
  watchIdle() {
    const g = this.game;
    let who = [], key = '';
    if (g && !g.dead && g.status === 'INITIAL_VIEWING') {
      who = g.players.filter((x) => !x.isBot && !x.ready && !this.connected(this.get(x.id) || {}));
      key = 'view:' + who.map((x) => x.id).join(',');
    } else if (g && !g.dead && !g.phase && g.turn && ['draw', 'choose', 'power', 'queen'].includes(g.turn.step)) {
      const a = g.players.find((x) => x.id === g.activeId);
      if (a && !a.isBot) { who = [a]; key = `turn:${g.turnNo}:${g.turn.step}:${g.turn.sel.length}:${this.connected(this.get(a.id) || {})}`; }
    }
    if (!who.length) key = '';
    if (this.idle && this.idle.key === key) return;
    if (this.idle) clearTimeout(this.idle.timer);
    this.idle = null;
    if (!key) return;
    const away = who.some((x) => !this.connected(this.get(x.id) || {}));
    // once a stand-in has started someone's turn, it finishes the rest of it briskly
    const quick = who.every((x) => (this.get(x.id) || {}).left) || (g.turn && this.standInTurn === g.turnNo && !key.startsWith('view'));
    const timer = setTimeout(() => {
      if (!this.idle || this.idle.key !== key || this.game !== g) return;
      this.idle = null;
      if (g.turn) this.standInTurn = g.turnNo;
      for (const x of who) {
        const b = this.standIns[x.id] ||= new Bot(g, x.id, 'medium', { standIn: true });
        try { b.think(); } catch (e) { console.error(e); }
      }
    }, quick ? 1500 : away ? AWAY_MS : IDLE_MS);
    this.idle = { key, timer };
  }
  event(ev) { for (const p of this.players) this.send(p, { type: 'event', ev }); }

  start() {
    this.game = new Game(this.players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot })), this.mode);
    this.game.onUpdate = () => this.broadcast();
    this.game.onEvent = (ev) => this.event(ev);
    for (const p of this.players) if (!p.isBot && !this.connected(p)) this.game.setConnected(p.id, false);
    this.bots = this.players.filter((p) => p.isBot).map((p) => new Bot(this.game, p.id, this.level));
    this.broadcast();
  }
  stopGame() {
    if (this.game) this.game.destroy();
    this.bots.forEach((b) => b.destroy());
    Object.values(this.standIns).forEach((b) => b.destroy());
    if (this.idle) clearTimeout(this.idle.timer);
    this.idle = null;
    this.standIns = {};
    this.game = null;
    this.bots = [];
    for (const p of this.players) p.ready = p.isBot;
  }
}

// A socket moving to another room (or seat) first lets go of the one it had.
function detach(ws) {
  const ctx = ws.ctx;
  ws.ctx = null;
  if (!ctx) return;
  const p = ctx.room.get(ctx.pid);
  if (p && p.ws === ws) dropped(ctx.room, p);
}

// A human's socket went away (closed, or moved elsewhere).
function dropped(room, p) {
  p.ws = null;
  if (room.game) room.game.setConnected(p.id, false); // its update broadcasts
  else room.broadcast();
  if (p.id === room.hostId) setTimeout(() => { if (rooms.get(room.code) === room && room.fixHost()) room.broadcast(); }, HOST_GRACE_MS + 50);
}

function attach(ws, room, p) {
  if (ws.ctx && (ws.ctx.room !== room || ws.ctx.pid !== p.id)) detach(ws);
  if (p.ws && p.ws !== ws) { try { p.ws.ctx = null; p.ws.close(4000, 'Opened in another tab'); } catch {} }
  p.ws = ws;
  p.left = false;
  ws.ctx = { room, pid: p.id };
  ws.send(JSON.stringify({ type: 'joined', code: room.code, pid: p.id, token: p.token, name: p.name }));
  if (room.game) room.game.setConnected(p.id, true);
  room.broadcast();
}

function err(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', msg })); }

const handlers = {
  create(ws, m) {
    const code = rooms.size < MAX_ROOMS && newCode();
    if (!code) return err(ws, 'The server is busy — try again in a minute');
    detach(ws); // one room per browser tab
    const room = new Room(code);
    rooms.set(room.code, room);
    const p = { id: newId(), token: newId() + newId(), name: cleanName(m.name), ready: true, isBot: false };
    room.players.push(p);
    room.hostId = p.id;
    attach(ws, room, p);
  },
  join(ws, m) {
    const room = rooms.get(str(m.code).toUpperCase().trim());
    if (!room) return err(ws, 'Room not found — check the code');
    if (room.game) return err(ws, 'That game has already started');
    if (room.players.length >= MAX_PLAYERS) return err(ws, `Room is full (${MAX_PLAYERS} players)`);
    detach(ws);
    const p = { id: newId(), token: newId() + newId(), name: cleanName(m.name), ready: false, isBot: false };
    room.players.push(p);
    attach(ws, room, p);
  },
  rejoin(ws, m) {
    const room = rooms.get(str(m.code).toUpperCase());
    const p = room && room.players.find((x) => x.token && x.token === m.token);
    if (!p) return ws.readyState === 1 && ws.send(JSON.stringify({ type: 'gone' }));
    attach(ws, room, p);
    if (room.fixHost()) room.broadcast();
  },
};

const roomHandlers = {
  ready(room, p, m) { if (!room.game) { p.ready = !!m.ready; room.broadcast(); } },
  setMode(room, p, m) {
    if (room.game || p.id !== room.hostId) return 'Only the host can change the mode';
    room.mode = m.mode === 'MD' ? 'MD' : 'FF';
    room.broadcast();
  },
  setLevel(room, p, m) {
    if (room.game || p.id !== room.hostId) return 'Only the host can change the bot level';
    room.level = LEVELS.includes(m.level) ? m.level : 'medium';
    room.broadcast();
  },
  addBot(room, p) {
    if (room.game || p.id !== room.hostId) return 'Only the host can add bots';
    if (room.players.length >= MAX_PLAYERS) return 'Room is full';
    const names = ['Botzilla', 'Robo Rita', 'Chip', 'Bleep', 'Sprocket', 'Gizmo'];
    const used = new Set(room.players.map((x) => x.name));
    room.players.push({ id: newId(), token: null, name: names.find((n) => !used.has(n)) || 'Bot', ready: true, isBot: true });
    room.broadcast();
  },
  kick(room, p, m) {
    if (room.game || p.id !== room.hostId) return 'Only the host can remove players';
    const t = room.get(m.id);
    if (!t || t.id === room.hostId) return;
    room.players = room.players.filter((x) => x !== t);
    if (t.ws) { room.send(t, { type: 'kicked' }); t.ws.ctx = null; }
    room.broadcast();
  },
  start(room, p) {
    if (room.game || p.id !== room.hostId) return 'Only the host can start';
    if (room.players.length < MIN_PLAYERS) return `CABO needs at least ${MIN_PLAYERS} players`;
    if (!room.players.every((x) => x.ready || x.id === room.hostId)) return 'Waiting for everyone to be ready';
    room.start();
  },
  rematch(room, p) {
    room.fixHost(true);
    if (p.id !== room.hostId) return 'Only the host can do that';
    if (room.game && room.game.status !== 'GAME_OVER') return 'Game still running';
    room.stopGame();
    room.players = room.players.filter((x) => x.isBot || room.connected(x));
    room.broadcast();
  },
  leave(room, p, m, ws) {
    ws.ctx = null;
    if (!room.game) {
      room.players = room.players.filter((x) => x !== p);
      if (room.hostId === p.id) { room.hostId = null; room.fixHost(true); }
      if (!room.players.some((x) => !x.isBot)) { rooms.delete(room.code); room.stopGame(); return; }
    } else {
      // mid-game the seat stays (a stand-in plays it); the role of host moves on right away
      p.ws = null;
      p.left = true;
      room.game.setConnected(p.id, false);
      if (p.id === room.hostId) room.fixHost(true);
    }
    room.broadcast();
  },
  act(room, p, m) {
    if (!room.game) return 'Game not started';
    const r = room.game.handle(p.id, m);
    return r && r.error;
  },
};

// A message arrived on a socket.
function onMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.type !== 'string') return;
  try {
    if (Object.hasOwn(handlers, m.type)) return handlers[m.type](ws, m);
    const ctx = ws.ctx;
    if (!ctx || !Object.hasOwn(roomHandlers, m.type)) return;
    const p = ctx.room.get(ctx.pid);
    if (!p || p.ws !== ws) return;
    const e = roomHandlers[m.type](ctx.room, p, m, ws);
    if (typeof e === 'string') err(ws, e);
  } catch (e) {
    console.error(e);
    err(ws, 'Server error — action ignored');
  }
}

// A socket closed.
function onClose(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  const p = ctx.room.get(ctx.pid);
  if (!p || p.ws !== ws) return;
  dropped(ctx.room, p);
}

// Drop rooms nobody human has touched for 30 minutes.
function sweep() {
  for (const [code, room] of rooms) {
    const anyone = room.players.some((p) => !p.isBot && room.connected(p));
    if (!anyone && Date.now() - room.touched > 30 * 60000) { room.stopGame(); rooms.delete(code); }
  }
}

module.exports = { onMessage, onClose, sweep };
