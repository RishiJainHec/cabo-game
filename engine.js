'use strict';
// CABO game engine — server-authoritative state machine. No networking here.
const crypto = require('crypto');

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C'];
const VALUE = { A: -1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13 };
const an = (rank) => (rank === 'A' || rank === '8' ? 'an ' : 'a ') + rank;
const POWER = {
  A: 'swap', 2: 'swap', 3: 'swap', 4: 'swap', 5: 'swap', 6: 'swap',
  7: 'peekOwn', 8: 'peekOwn', 9: 'peekOpp', 10: 'peekOpp', J: 'blindSwap', Q: 'queen', K: 'kingSwap',
};
const GRID = 4; // indices 0-3 = 2x2 grid (2,3 = bottom row); 4+ = penalty area

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const makeDeck = () => {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ id: r + s, rank: r, suit: s });
  return d;
};

class Game {
  constructor(roomPlayers, mode, opts = {}) {
    this.mode = mode === 'MD' ? 'MD' : 'FF';
    this.matchMs = opts.matchMs ?? 5000;   // fixed matching window
    this.giveMs = opts.giveMs ?? 4000;     // time to choose a card to hand over after an opponent match
    this.viewPhaseMs = opts.viewPhaseMs ?? 90000; // AFK fallback; normally starts once everyone is ready
    this.gameId = crypto.randomBytes(4).toString('hex');
    this.reveals = []; // cards shown to everyone (failed match attempts)
    this.graceMs = opts.graceMs ?? 400;    // Fastest Finger: in-flight clicks that lost the race
    this.pauseMs = opts.pauseMs ?? 1800;   // breather after a matching window before the next turn
    this.onUpdate = () => {};
    this.onEvent = () => {};
    this.players = roomPlayers.map((rp) => ({
      id: rp.id, name: rp.name, isBot: !!rp.isBot, connected: true,
      slots: [], reserved: new Set(), locked: false, caller: false, exhausted: false,
      viewed: false, ready: false,
    }));
    this.verCounter = 0;
    this.phaseCounter = 0;
    this.log = [];
    this.peeks = {};
    this.seen = new Set();
    this.phase = null;
    this.lastClosed = null;
    this.hand = null;
    this.turn = null;
    this.activeId = null;
    this.caboCaller = null;
    this.autoCaboPending = null;
    this.queue = [];
    this.results = null;
    this.timer = null;
    this.dead = false;

    // Deal
    this.deck = shuffle(makeDeck());
    this.discard = [];
    for (const pl of this.players) for (let i = 0; i < GRID; i++) pl.slots.push(this.slot(this.deck.pop()));
    // The discard pile starts empty; the first turn's discard opens it.
    this.startIdx = crypto.randomInt(this.players.length);
    this.status = 'INITIAL_VIEWING';
    this.viewDeadline = Date.now() + this.viewPhaseMs;
    this.addLog(`Cards dealt. ${this.mode === 'FF' ? 'Fastest Finger' : 'Multiple Discard'} mode. Peek at your bottom two cards!`, 'sys');
    this.reschedule();
  }

  // ---------- helpers ----------
  slot(card) { return { card, ver: ++this.verCounter }; }
  p(id) { return this.players.find((x) => x.id === id); }
  occupied(pl) { return pl.slots.map((s, i) => (s ? i : -1)).filter((i) => i >= 0); }
  count(pl) { return this.occupied(pl).length + pl.reserved.size; }
  top() { return this.discard[this.discard.length - 1] || null; }
  oppTargets(selfId) {
    const out = [];
    for (const pl of this.players) {
      if (pl.id === selfId || pl.locked) continue;
      for (const i of this.occupied(pl)) out.push({ owner: pl.id, idx: i });
    }
    return out;
  }
  addLog(text, kind = 'info') {
    this.log.push({ t: Date.now(), text, kind });
    if (this.log.length > 80) this.log.shift();
  }
  fx(kind, data = {}) { this.onEvent({ kind, ...data }); }
  update() { if (!this.dead) this.onUpdate(); }
  destroy() { this.dead = true; clearTimeout(this.timer); }

  look(owner, idx, ver, allowLocked = false) {
    const pl = this.p(owner);
    if (!pl) return { err: 'No such player' };
    if (!Number.isInteger(idx) || idx < 0 || idx >= pl.slots.length) return { err: 'No such card' };
    const s = pl.slots[idx];
    if (!s) return { err: 'That spot is empty' };
    if (ver !== s.ver) return { err: 'That card just moved — try again' };
    if (pl.locked && !allowLocked) return { err: `${pl.name}'s cards are locked` };
    return { pl, idx, s };
  }

  // Draw from the face-down pile, recycling the discard pile (minus its top card) when empty.
  drawCard() {
    if (this.deck.length === 0) {
      if (this.discard.length <= 1) return null;
      const top = this.discard.pop();
      this.deck = shuffle(this.discard);
      this.discard = [top];
      this.addLog('Draw pile empty — discards reshuffled into a new draw pile.', 'sys');
      this.fx('reshuffle');
    }
    return this.deck.pop();
  }

  addPeek(viewer, owner, idx, until) {
    const s = this.p(owner).slots[idx];
    (this.peeks[viewer] ||= []).push({ owner, idx, ver: s.ver, card: s.card, until });
  }

  // ---------- timing ----------
  reschedule() {
    clearTimeout(this.timer);
    if (this.dead) return;
    let next = Infinity;
    if (this.status === 'INITIAL_VIEWING') next = this.viewDeadline;
    if (this.status === 'RESOLVING') next = this.holdUntil;
    if (this.phase) {
      if (this.phase.open) next = Math.min(next, this.phase.deadline);
      for (const g of this.phase.gives) next = Math.min(next, g.due);
      if (this.phase.endAt) next = Math.min(next, this.phase.endAt);
    }
    if (next === Infinity) return;
    this.timer = setTimeout(() => {
      // a bug in one game must never take the whole server down
      try { this.tick(); } catch (e) { console.error(e); }
    }, Math.max(0, next - Date.now()) + 5);
  }

  tick() {
    if (this.dead) return;
    const now = Date.now();
    if (this.status === 'INITIAL_VIEWING' && now >= this.viewDeadline) {
      this.beginTurns();
    } else if (this.status === 'RESOLVING' && now >= this.holdUntil) {
      this.advance();
    } else if (this.phase) {
      if (this.phase.open && now >= this.phase.deadline) this.phase.open = false;
      for (const g of [...this.phase.gives]) if (now >= g.due) this.autoGive(g);
      this.maybeAdvance();
    }
    this.update();
    this.reschedule();
  }

  // ---------- flow ----------
  beginTurns() {
    for (const pl of this.players) pl.ready = true;
    this.peeks = {};
    const first = this.players[this.startIdx];
    this.addLog(`${first.name} was randomly chosen to start.`, 'sys');
    this.startTurn(first.id);
  }

  startTurn(id) {
    this.turnNo = (this.turnNo || 0) + 1;
    this.activeId = id;
    this.hand = null;
    this.phase = null;
    this.turn = { step: 'draw', sel: [], qt: null, power: null, powerDone: false, final: this.caboCaller != null };
    this.status = this.caboCaller != null ? 'FINAL_TURNS' : 'PLAYER_TURN';
    const pl = this.p(id);
    this.addLog(this.turn.final ? `Final turn: ${pl.name}` : `${pl.name}'s turn`, 'turn');
    this.fx('turn', { pid: id });
  }

  openMatching() {
    const now = Date.now();
    this.hand = null;
    this.turn.step = 'matching';
    this.status = 'MATCHING_WINDOW';
    this.phase = {
      id: ++this.phaseCounter, start: now, deadline: now + this.matchMs, mode: this.mode,
      ref: this.top(), open: true, matched: false, winnerId: null, matches: 0,
      gives: [], failed: new Set(),
    };
    // Power peeks stay visible for the window plus a moment
    for (const list of Object.values(this.peeks)) for (const k of list) k.until = Math.min(k.until, this.phase.deadline + 3000);
    this.fx('window', { phaseId: this.phase.id });
  }

  maybeAdvance() {
    const ph = this.phase;
    if (!ph || ph.open || ph.gives.length || this.status !== 'MATCHING_WINDOW') return;
    // Matching is closed; hold the result on screen briefly before the next turn
    if (ph.endAt == null) ph.endAt = Date.now() + this.pauseMs;
    if (Date.now() >= ph.endAt) this.advance();
  }

  advance() {
    this.phase = null;
    const t = this.turn;
    if (t && t.power && !t.powerDone) {
      const drawer = this.p(this.activeId);
      if (!drawer.locked && this.canPower()) {
        t.step = 'power';
        t.sel = [];
        this.status = 'AWAITING_ACTION';
        this.fx('power', { pid: drawer.id, rank: t.power });
        return;
      }
      t.powerDone = true;
      if (!drawer.locked) this.addLog(`${drawer.name}'s ${t.power} had nothing to use its power on.`);
    }
    if (this.autoCaboPending != null && this.caboCaller == null) {
      const c = this.p(this.autoCaboPending);
      c.caller = true;
      this.caboCaller = c.id;
      this.queue = this.buildQueue(this.activeId);
      this.addLog(`${c.name} ran out of cards — automatic CABO! Final turns begin.`, 'cabo');
      this.fx('cabo', { pid: c.id, auto: true });
    }
    this.autoCaboPending = null;
    if (this.caboCaller != null) return this.nextFinal();
    const n = this.players.length;
    let i = this.players.findIndex((x) => x.id === this.activeId);
    for (let k = 0; k < n; k++) {
      i = (i + 1) % n;
      if (!this.players[i].locked) return this.startTurn(this.players[i].id);
    }
    this.endGame('Nobody can move.');
  }

  // Everyone except the caller and locked players, in turn order starting after `fromId` (wrapping to include fromId).
  buildQueue(fromId) {
    const n = this.players.length;
    const start = this.players.findIndex((x) => x.id === fromId);
    const q = [];
    for (let k = 1; k <= n; k++) {
      const pl = this.players[(start + k) % n];
      if (!pl.locked && pl.id !== this.caboCaller) q.push(pl.id);
    }
    return q;
  }

  nextFinal() {
    while (this.queue.length) {
      const id = this.queue.shift();
      if (!this.p(id).locked) return this.startTurn(id);
    }
    this.endGame();
  }

  endGame(reason) {
    clearTimeout(this.timer);
    this.status = 'GAME_OVER';
    this.phase = null;
    this.hand = null;
    this.peeks = {};
    if (reason) this.addLog(reason, 'sys');
    const res = this.players.map((pl) => {
      const cards = pl.slots.map((s, idx) => (s ? { idx, card: s.card, penalty: idx >= GRID } : null)).filter(Boolean);
      const grid = pl.slots.slice(0, GRID);
      const penalties = pl.slots.slice(GRID).filter(Boolean).length;
      const four = grid.length === GRID && grid.every(Boolean) && penalties === 0 && grid.every((s) => s.card.rank === grid[0].card.rank);
      const total = four ? -4 : cards.reduce((t, c) => t + VALUE[c.card.rank], 0);
      return { id: pl.id, name: pl.name, cards, four, total, caller: pl.caller };
    });
    res.sort((a, b) => a.total - b.total);
    res.forEach((r, i) => { r.place = i > 0 && r.total === res[i - 1].total ? res[i - 1].place : i + 1; });
    const best = res[0].total;
    const winners = res.filter((r) => r.total === best);
    this.results = { players: res, tie: winners.length > 1, winners: winners.map((w) => w.id) };
    this.addLog(winners.length > 1
      ? `Tie! ${winners.map((w) => w.name).join(' & ')} share the win with ${best}.`
      : `${winners[0].name} wins with ${best} points!`, 'win');
    this.fx('gameover');
  }

  exhausted(pl) {
    pl.locked = true;
    pl.exhausted = true;
    this.addLog(`${pl.name} has no cards left and is locked!`, 'cabo');
    if (this.caboCaller == null && this.autoCaboPending == null) this.autoCaboPending = pl.id;
  }

  // `shown`: the wrongly clicked card, revealed to everyone for a few seconds.
  penalty(pid, reason, shown) {
    const pl = this.p(pid);
    if (shown) this.reveals.push({ ...shown, until: Date.now() + 3500 });
    const card = this.drawCard();
    if (!card) { this.endGame('No cards left to draw — game ends.'); return; }
    let idx = pl.slots.findIndex((s, i) => i >= GRID && !s && !pl.reserved.has(i));
    if (idx < 0) { idx = pl.slots.length; pl.slots.push(null); }
    pl.slots[idx] = this.slot(card);
    this.addLog(reason === 'lost'
      ? `${pl.name} lost the race — penalty card!`
      : `${pl.name} tried ${an(shown.card.rank)}, not ${an(this.phase.ref.rank)} — penalty card!`, 'bad');
    this.fx('penalty', {
      pid, reason, idx,
      ...(shown && { shown: { owner: shown.owner, idx: shown.idx, card: shown.card }, ref: this.phase.ref.rank }),
    });
  }

  // ---------- actions ----------
  handle(pid, msg) {
    const pl = this.p(pid);
    if (!pl || !msg || typeof msg.a !== 'string') return { error: 'Bad request' };
    const key = (typeof msg.id === 'string' || typeof msg.id === 'number') ? pid + ':' + String(msg.id).slice(0, 40) : null;
    if (key && this.seen.has(key)) return { ok: true, dup: true };
    if (this.status === 'GAME_OVER') return { error: 'The game is over' };
    const fn = /^[a-z]+$/.test(msg.a) && this['act_' + msg.a];
    if (typeof fn !== 'function') return { error: 'Unknown action' };
    const r = fn.call(this, pl, msg);
    if (r && r.error) return r; // a refused action can be retried with the same id
    if (key) {
      this.seen.add(key);
      if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
    }
    this.update();
    this.reschedule();
    return r || { ok: true };
  }

  act_view(pl) {
    if (this.status !== 'INITIAL_VIEWING') return { error: 'Not the viewing phase' };
    if (pl.viewed) return { error: 'You already looked at your cards' };
    pl.viewed = true;
    const until = Date.now() + 10 * 60000; // visible until the player clicks Ready
    this.addPeek(pl.id, pl.id, 2, until);
    this.addPeek(pl.id, pl.id, 3, until);
  }

  act_ready(pl) {
    if (this.status !== 'INITIAL_VIEWING') return { error: 'Not the viewing phase' };
    pl.viewed = true;
    pl.ready = true;
    delete this.peeks[pl.id];
    if (this.players.every((x) => x.ready)) this.beginTurns();
  }

  activeCheck(pl, step) {
    if (pl.id !== this.activeId) return { error: "It's not your turn" };
    if (!this.turn || (Array.isArray(step) ? !step.includes(this.turn.step) : this.turn.step !== step)) return { error: 'Not allowed right now' };
    return null;
  }

  act_draw(pl) {
    const e = this.activeCheck(pl, 'draw'); if (e) return e;
    const c = this.drawCard();
    if (!c) { this.endGame('No cards left to draw — game ends.'); return; }
    this.turn.sel = [];
    if (POWER[c.rank] !== 'swap') {
      // 7–K go face-up on the pile at once, so everyone gets the same matching window as the drawer;
      // the drawer uses the power after the window closes.
      this.turn.power = c.rank;
      this.discard.push(c);
      this.addLog(`${pl.name} drew ${an(c.rank)} — it's on the pile!`);
      this.fx('reveal', { pid: pl.id, card: c });
      this.openMatching();
      return;
    }
    // A–6 stay private while the drawer picks which card to replace
    this.hand = c;
    this.turn.step = 'choose';
    this.status = 'AWAITING_ACTION';
    this.addLog(`${pl.name} drew a card.`);
    this.fx('draw', { pid: pl.id });
  }

  powerRank() { return this.hand ? this.hand.rank : this.turn && this.turn.power; }

  act_cabo(pl) {
    const e = this.activeCheck(pl, 'draw'); if (e) return e;
    if (this.caboCaller != null) return { error: 'CABO has already been called' };
    pl.caller = true;
    pl.locked = true;
    this.caboCaller = pl.id;
    this.queue = this.buildQueue(pl.id);
    this.addLog(`${pl.name} called CABO! Everyone else gets one final turn.`, 'cabo');
    this.fx('cabo', { pid: pl.id });
    this.nextFinal();
  }

  canPower() {
    const me = this.p(this.activeId);
    const own = this.occupied(me).length;
    const opp = this.oppTargets(me.id).length;
    switch (POWER[this.powerRank()]) {
      case 'peekOwn': return own > 0;
      case 'peekOpp': case 'queen': return opp > 0;
      case 'blindSwap': return own > 0 && own - 1 + opp > 0;
      case 'kingSwap': return opp >= 2;
      default: return false;
    }
  }

  act_swap(pl, m) {
    const e = this.activeCheck(pl, 'choose'); if (e) return e;
    if (POWER[this.hand.rank] !== 'swap') return { error: 'Cards 7 and above must use their power' };
    if (m.owner !== pl.id) return { error: 'Swap with one of your own cards' };
    const t = this.look(pl.id, m.idx, m.ver, true); if (t.err) return { error: t.err };
    const out = t.s.card;
    pl.slots[m.idx] = this.slot(this.hand);
    this.discard.push(out);
    this.addLog(`${pl.name} swapped a card and discarded ${an(out.rank)}.`);
    this.fx('swap', { pid: pl.id, a: { owner: pl.id, idx: m.idx } });
    this.openMatching();
  }

  act_cancel(pl) {
    const e = this.activeCheck(pl, 'power'); if (e) return e;
    if (!this.turn.sel.length) return { error: 'Nothing to undo' };
    this.turn.sel = [];
  }

  // The power card is already on the pile; once its power is used the turn ends after a short hold
  // (longer when a card was peeked, so the player has time to read it).
  finishPower(text, peeked) {
    this.addLog(text);
    const t = this.turn;
    t.powerDone = true;
    t.step = 'done';
    const hold = peeked && this.pauseMs > 0 ? Math.max(this.pauseMs, 3000) : this.pauseMs;
    for (const list of Object.values(this.peeks)) for (const k of list) k.until = Math.min(k.until, Date.now() + hold + 1500);
    if (hold <= 0) return this.advance();
    this.status = 'RESOLVING';
    this.holdUntil = Date.now() + hold;
  }

  act_target(pl, m) {
    const e = this.activeCheck(pl, 'power'); if (e) return e;
    const t = this.look(m.owner, m.idx, m.ver); if (t.err) return { error: t.err };
    const r = this.powerRank();
    const mine = m.owner === pl.id;
    const sel = this.turn.sel;
    const far = Date.now() + 10 * 60000;
    switch (POWER[r]) {
      case 'peekOwn':
        if (!mine) return { error: 'Pick one of your own cards' };
        this.addPeek(pl.id, pl.id, m.idx, far);
        this.fx('peek', { pid: pl.id, a: { owner: pl.id, idx: m.idx } });
        return this.finishPower(`${pl.name} used a ${r} to peek at one of their own cards.`, true);
      case 'peekOpp':
        if (mine) return { error: "Pick an opponent's card" };
        this.addPeek(pl.id, m.owner, m.idx, far);
        this.fx('peek', { pid: pl.id, a: { owner: m.owner, idx: m.idx } });
        return this.finishPower(`${pl.name} used a ${r} to inspect a card belonging to ${t.pl.name}.`, true);
      case 'queen':
        if (mine) return { error: "Pick an opponent's card" };
        this.addPeek(pl.id, m.owner, m.idx, far);
        this.turn.qt = { owner: m.owner, idx: m.idx, ver: m.ver };
        this.turn.step = 'queen';
        this.addLog(`${pl.name} used a Queen to inspect a card belonging to ${t.pl.name}.`);
        this.fx('peek', { pid: pl.id, a: { owner: m.owner, idx: m.idx } });
        return;
      case 'blindSwap':
      case 'kingSwap': {
        const king = POWER[r] === 'kingSwap';
        if (sel.length === 0) {
          if (king && mine) return { error: "King swaps two opponents' cards" };
          if (!king && !mine) return { error: 'First pick one of your own cards' };
          sel.push({ owner: m.owner, idx: m.idx, ver: m.ver });
          return;
        }
        if (king && mine) return { error: "King swaps two opponents' cards" };
        const a = sel[0];
        if (a.owner === m.owner && a.idx === m.idx) return { error: 'Pick a different card' };
        const ta = this.look(a.owner, a.idx, a.ver);
        if (ta.err) { this.turn.sel = []; return { error: 'First card changed — pick again' }; }
        this.swapSlots(ta, t);
        const names = a.owner === m.owner ? `two of ${t.pl.name}'s cards` : `cards between ${ta.pl.name} and ${t.pl.name}`;
        this.fx('swapfx', { pid: pl.id, a: { owner: a.owner, idx: a.idx }, b: { owner: m.owner, idx: m.idx } });
        return this.finishPower(`${pl.name} used a ${r === 'J' ? 'Jack' : 'King'} to blind-swap ${names}.`);
      }
      default:
        return { error: 'This card has no power' };
    }
  }

  swapSlots(a, b) {
    const ca = a.pl.slots[a.idx].card;
    const cb = b.pl.slots[b.idx].card;
    a.pl.slots[a.idx] = this.slot(cb);
    b.pl.slots[b.idx] = this.slot(ca);
  }

  act_queen(pl, m) {
    const e = this.activeCheck(pl, 'queen'); if (e) return e;
    const q = this.turn.qt;
    if (!m.swap) {
      return this.finishPower(`${pl.name} kept the cards unchanged.`, true);
    }
    if (m.owner !== pl.id) return { error: 'Pick one of your own cards' };
    const mine = this.look(pl.id, m.idx, m.ver, true); if (mine.err) return { error: mine.err };
    const t = this.look(q.owner, q.idx, q.ver);
    if (t.err) return this.finishPower(`${pl.name}'s Queen swap was cancelled (target unavailable).`);
    this.swapSlots(mine, t);
    this.fx('swapfx', { pid: pl.id, a: { owner: pl.id, idx: m.idx }, b: { owner: q.owner, idx: q.idx } });
    return this.finishPower(`${pl.name} used a Queen to swap a card with ${t.pl.name}.`, true);
  }

  act_match(pl, m) {
    const ph = this.phase;
    const now = Date.now();
    if (pl.locked) return { error: 'Your cards are locked' };
    const current = ph && m.phaseId === ph.id;
    if (!current || !ph.open) {
      // Fastest Finger: a click already in flight when someone else won the race (the phase may
      // still be on screen for its short pause, or already gone).
      const lc = this.lastClosed;
      if (lc && m.phaseId === lc.id && now - lc.at <= this.graceMs && pl.id !== lc.winnerId && !lc.penalized.has(pl.id)) {
        const t = this.p(m.owner);
        const ok = t && !t.locked && Number.isInteger(m.idx) && m.idx >= 0 && m.idx < t.slots.length &&
          (t.slots[m.idx] || (m.owner === lc.owner && m.idx === lc.idx));
        if (ok) { lc.penalized.add(pl.id); this.penalty(pl.id, 'lost'); return; }
      }
      return { error: current ? 'Too late!' : 'Matching window is closed' };
    }
    if (now > ph.deadline) return { error: 'Too late!' };
    if (ph.gives.some((g) => g.attackerId === pl.id)) return { error: 'Give a card first!' };
    const t = this.look(m.owner, m.idx, m.ver); if (t.err) return { error: t.err };
    const failKey = `${pl.id}:${m.owner}:${m.idx}:${t.s.ver}`;
    if (ph.failed.has(failKey)) return { error: 'You already tried that card' };
    if (this.mode === 'FF' && ph.matched) {
      if (pl.id === ph.winnerId) return { error: 'You already matched this round' };
      ph.failed.add(failKey);
      this.penalty(pl.id, 'lost');
      return;
    }
    if (t.s.card.rank !== ph.ref.rank) {
      ph.failed.add(failKey);
      this.penalty(pl.id, 'wrong', { owner: m.owner, idx: m.idx, ver: t.s.ver, card: t.s.card });
      return;
    }
    // Success
    const card = t.s.card;
    t.pl.slots[m.idx] = null;
    this.discard.push(card);
    ph.matched = true;
    ph.matches++;
    if (!ph.winnerId) ph.winnerId = pl.id;
    if (t.pl.id === pl.id) {
      this.addLog(`${pl.name} matched their own ${card.rank}!`, 'good');
      this.fx('match', { pid: pl.id, owner: pl.id, idx: m.idx, card });
      if (this.count(pl) === 0) this.exhausted(pl);
    } else {
      this.addLog(`${pl.name} matched ${t.pl.name}'s ${card.rank}!`, 'good');
      this.fx('match', { pid: pl.id, owner: t.pl.id, idx: m.idx, card });
      t.pl.reserved.add(m.idx);
      const g = { attackerId: pl.id, owner: t.pl.id, idx: m.idx, due: Math.max(ph.deadline, now + this.giveMs) };
      ph.gives.push(g);
      const mine = this.occupied(pl);
      if (mine.length === 1) this.doGive(g, mine[0]); // only one card: no choice to make
    }
    if (this.mode === 'FF') {
      this.lastClosed = { id: ph.id, winnerId: pl.id, owner: t.pl.id, idx: m.idx, at: now, penalized: new Set() };
      if (this.autoCaboPending == null) ph.open = false; // window keeps running only for the last-card rule
      this.maybeAdvance();
    }
  }

  act_give(pl, m) {
    const ph = this.phase;
    const g = ph && ph.gives.find((x) => x.attackerId === pl.id);
    if (!g) return { error: 'Nothing to give' };
    if (m.owner !== pl.id) return { error: 'Give one of your own cards' };
    const s = this.look(pl.id, m.idx, m.ver, true); if (s.err) return { error: s.err };
    this.doGive(g, m.idx);
    this.maybeAdvance();
  }

  autoGive(g) {
    const pl = this.p(g.attackerId);
    const mine = this.occupied(pl);
    if (!mine.length) {
      this.phase.gives = this.phase.gives.filter((x) => x !== g);
      const victim = this.p(g.owner);
      victim.reserved.delete(g.idx);
      // nothing came back to fill the gap: a player left with no cards is out, like any other
      if (this.count(victim) === 0 && !victim.locked) this.exhausted(victim);
      return;
    }
    this.doGive(g, mine[crypto.randomInt(mine.length)]);
  }

  doGive(g, idx) {
    const a = this.p(g.attackerId);
    const t = this.p(g.owner);
    const card = a.slots[idx].card;
    a.slots[idx] = null;
    t.slots[g.idx] = this.slot(card);
    t.reserved.delete(g.idx);
    this.phase.gives = this.phase.gives.filter((x) => x !== g);
    this.addLog(`${a.name} gave ${t.name} a face-down card.`);
    this.fx('give', { pid: a.id, from: { owner: a.id, idx }, to: { owner: t.id, idx: g.idx } });
    if (this.count(a) === 0) this.exhausted(a);
  }

  setConnected(pid, on) {
    const pl = this.p(pid);
    if (!pl || pl.connected === on) return;
    pl.connected = on;
    this.addLog(`${pl.name} ${on ? 'reconnected' : 'disconnected'}.`, 'sys');
    this.update();
  }

  // ---------- per-player view (hidden information filtered) ----------
  view(pid) {
    const now = Date.now();
    const over = this.status === 'GAME_OVER';
    const active = pid === this.activeId;
    const ph = this.phase;
    const peeks = (this.peeks[pid] || []).filter((k) => {
      const s = this.p(k.owner).slots[k.idx];
      return k.until > now && s && s.ver === k.ver;
    }).map(({ owner, idx, ver, card, until }) => ({ owner, idx, ver, card, until }));
    this.reveals = this.reveals.filter((k) => k.until > now);
    const reveals = this.reveals.filter((k) => { const s = this.p(k.owner).slots[k.idx]; return s && s.ver === k.ver; })
      .map(({ owner, idx, ver, card, until }) => ({ owner, idx, ver, card, until }));
    let turn = null;
    if (this.turn) {
      turn = { step: this.turn.step, final: this.turn.final, power: this.turn.power };
      if (active) Object.assign(turn, {
        sel: this.turn.sel.map(({ owner, idx }) => ({ owner, idx })),
        qt: this.turn.qt && { owner: this.turn.qt.owner, idx: this.turn.qt.idx },
        canPower: this.powerRank() ? this.canPower() : false,
      });
      else if (turn.step === 'power' || turn.step === 'queen') turn.step = 'choose';
    }
    return {
      gameId: this.gameId, status: this.status, mode: this.mode, now, you: pid, reveals,
      players: this.players.map((pl) => ({
        id: pl.id, name: pl.name, isBot: pl.isBot, connected: pl.connected, locked: pl.locked,
        caller: pl.caller, exhausted: pl.exhausted, ready: pl.ready, viewed: pl.viewed, count: this.count(pl),
        slots: pl.slots.map((s, i) => (s ? (over ? { ver: s.ver, card: s.card } : { ver: s.ver }) : { empty: true, reserved: pl.reserved.has(i) })),
      })),
      draw: this.deck.length, discardTop: this.top(), discardCount: this.discard.length, discardRecent: this.discard.slice(-4),
      activeId: this.activeId, turn,
      hand: active ? this.hand : null, handHeld: !!this.hand,
      phase: ph && {
        id: ph.id, deadline: ph.deadline, open: ph.open, matched: ph.matched, winnerId: ph.winnerId,
        matches: ph.matches, gives: ph.gives.map((g) => ({ attackerId: g.attackerId, owner: g.owner, idx: g.idx, due: g.due })),
      },
      viewDeadline: this.status === 'INITIAL_VIEWING' ? this.viewDeadline : null,
      peeks, caboCaller: this.caboCaller, queue: this.queue.filter((id) => !this.p(id).locked),
      log: this.log.slice(-40), results: this.results,
    };
  }

  // Test helper: every card exists exactly once.
  integrity() {
    const ids = [...this.deck, ...this.discard, ...(this.hand ? [this.hand] : [])].map((c) => c.id);
    for (const pl of this.players) for (const s of pl.slots) if (s) ids.push(s.card.id);
    return ids.length === 52 && new Set(ids).size === 52;
  }
}

module.exports = { Game, VALUE, POWER, RANKS, makeDeck };
