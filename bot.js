'use strict';
// In-process bot: plays through the same handle()/view() API a browser uses,
// and only "knows" cards the server has let it see (its peeks and public wrong-match reveals).
const { VALUE, POWER } = require('./engine');

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = ([lo, hi]) => lo + Math.random() * (hi - lo);

// How each difficulty plays.
//  think/react: delay before acting on its turn / in a matching window (ms)
//  matchChance: how often it actually grabs a card it knows matches
//  forget:      chance per own turn of forgetting each remembered card
//  blunder:     chance per matching window of grabbing a random card (usually wrong)
//  steal:       will it grab opponents' cards it has spied on?
//  smart:       aims powers well (spies unknown cards, dumps its worst card with a Jack)
//  caboAt:      calls CABO when its estimated total is at or below this
const LEVELS = {
  easy: { think: [2200, 3600], react: [2400, 4300], matchChance: 0.5, forget: 0.25, blunder: 0.08, steal: false, smart: false, caboAt: 2, caboLate: 16 },
  medium: { think: [1500, 3000], react: [1200, 2800], matchChance: 0.85, forget: 0, blunder: 0, steal: true, smart: false, caboAt: 6, caboLate: 10 },
  hard: { think: [900, 1800], react: [450, 1200], matchChance: 1, forget: 0, blunder: 0, steal: true, smart: true, caboAt: 9, caboLate: 7 },
};

class Bot {
  // standIn: plays only the moves a stuck human owes (their turn) and never races to match
  constructor(game, pid, level = 'medium', { standIn = false } = {}) {
    this.game = game;
    this.pid = pid;
    this.standIn = standIn;
    this.cfg = LEVELS[level] || LEVELS.medium;
    this.mem = new Map(); // slot ver -> card
    this.timer = null;
    this.turns = 0;
    this.n = 0;
    this.lastPhase = null;
    this.tried = new Set(); // open window: "phase:slot" matches already decided on
  }

  poke() {
    if (this.timer || this.game.dead) return;
    const g = this.game;
    // react quickly to a fresh discard; take normal thinking time over our own moves
    const matching = g.phase && g.phase.open && (!g.open || g.activeId !== this.pid);
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.think(); } catch (e) { console.error(e); } // never let a bot take the server down
    }, rand(matching ? this.cfg.react : this.cfg.think));
  }

  act(msg) {
    const r = this.game.handle(this.pid, { ...msg, id: 'bot' + this.pid + ':' + ++this.n });
    return r && !r.error;
  }

  think() {
    const g = this.game;
    if (g.dead || g.status === 'GAME_OVER') return;
    const cfg = this.cfg;
    const v = g.view(this.pid);
    for (const k of [...v.peeks, ...v.reveals]) this.mem.set(k.ver, k.card);
    const me = v.players.find((p) => p.id === this.pid);
    const own = me.slots.map((s, i) => ({ ...s, idx: i })).filter((s) => !s.empty);
    const known = (s) => this.mem.get(s.ver);
    const val = (s, unknown) => (known(s) ? VALUE[known(s).rank] : unknown);
    const opps = v.players.filter((p) => p.id !== this.pid && !p.locked)
      .flatMap((p) => p.slots.map((s, i) => ({ ...s, idx: i, owner: p.id })).filter((s) => !s.empty));

    if (v.status === 'INITIAL_VIEWING') {
      if (!me.viewed) this.act({ a: 'view' });
      else if (!me.ready) this.act({ a: 'ready' });
      return this.poke();
    }
    if (me.locked) return;

    const give = v.phase && v.phase.gives.find((x) => x.attackerId === this.pid);
    if (give) {
      // hand over our worst card: highest known value, else an unknown one
      const order = own.slice().sort((a, b) => val(b, 6) - val(a, 6));
      const s = cfg.smart ? order[0] : order.find((x) => !known(x)) || order[0];
      if (s) this.act({ a: 'give', owner: this.pid, idx: s.idx, ver: s.ver });
      return;
    }

    if (v.phase && v.phase.open && !(v.mode === 'FF' && v.phase.matched)) {
      if (!this.standIn && !this.busy(v)) {
        const ref = v.phase.ref || v.discardTop.rank;
        // Never throw away our own Ace: at −1 it beats having no card at all. (Grabbing someone
        // else's Ace is still good: they lose the −1 and get our worst card in exchange.)
        const mine = VALUE[ref] > 0 && own.find((s) => known(s) && known(s).rank === ref);
        const theirs = cfg.steal && opps.find((s) => known(s) && known(s).rank === ref);
        const t = mine ? { ...mine, owner: this.pid } : theirs;
        // open window: think() runs many times per discard, so each chance is decided only once
        const key = t && v.phase.id + ':' + t.owner + ':' + t.ver;
        const fresh = !v.open || !this.tried.has(key);
        if (t && fresh) this.tried.add(key);
        if (t && fresh && Math.random() < cfg.matchChance) {
          if (this.act({ a: 'match', phaseId: v.phase.id, owner: t.owner, idx: t.idx, ver: t.ver }) && v.open) return this.poke();
        } else if (!t && this.lastPhase !== v.phase.id && Math.random() < cfg.blunder) {
          const s = pick(opps); // an overconfident guess
          if (s) this.act({ a: 'match', phaseId: v.phase.id, owner: s.owner, idx: s.idx, ver: s.ver });
        }
        this.lastPhase = v.phase.id;
      }
      if (!v.open) return; // a timed window pauses the game; an open one doesn't
    }
    if (v.open && this.tried.size > 200) this.tried.clear();

    if (v.activeId !== this.pid || !v.turn) return;
    const step = v.turn.step;
    if (step === 'draw') {
      this.turns++;
      if (cfg.forget) for (const k of [...this.mem.keys()]) if (Math.random() < cfg.forget) this.mem.delete(k);
      const estimate = own.reduce((t, s) => t + val(s, 6), 0);
      const late = this.turns > cfg.caboLate && Math.random() < 0.35;
      if (!v.turn.final && v.caboCaller == null && (estimate <= cfg.caboAt || late)) this.act({ a: 'cabo' });
      else if (!this.act({ a: 'draw' })) { this.turns--; return this.poke(); } // open window: others still get their beat to match
      return;
    }
    const h = v.hand || { rank: v.turn.power }; // power cards are already on the pile
    const worstOwn = () => own.map((s) => ({ s, val: val(s, 7) })).sort((a, b) => b.val - a.val)[0];
    if (step === 'choose') {
      if (POWER[h.rank] === 'swap' && own.length) {
        const w = cfg.smart || Math.random() < 0.7 ? worstOwn().s : pick(own);
        this.act({ a: 'swap', owner: this.pid, idx: w.idx, ver: w.ver });
        this.rememberSwap = { idx: w.idx, card: h };
      }
      this.afterSwap();
      return;
    }
    if (step === 'power') {
      const p = POWER[h.rank];
      const unknownOwn = own.filter((s) => !known(s));
      const unknownOpp = opps.filter((s) => !known(s));
      const target = (s) => this.act({ a: 'target', owner: s.owner || this.pid, idx: s.idx, ver: s.ver });
      if (p === 'peekOwn') { if (own.length) target(pick(unknownOwn.length ? unknownOwn : own)); }
      else if (p === 'peekOpp' || p === 'queen') { const s = pick(cfg.smart && unknownOpp.length ? unknownOpp : opps); if (s) target(s); }
      else if (p === 'blindSwap') {
        if (!v.turn.sel.length) { if (own.length) target(cfg.smart ? worstOwn().s : pick(own)); }
        else {
          // smart: trade our worst card for an opponent card we know is low
          const low = opps.filter((s) => known(s)).sort((a, b) => val(a, 99) - val(b, 99))[0];
          const s = cfg.smart && low ? low : pick(opps.length ? opps : own.filter((x) => x.idx !== v.turn.sel[0].idx));
          if (s) target(s);
        }
      } else if (p === 'kingSwap') {
        const sel = v.turn.sel[0];
        const s = pick(opps.filter((x) => !sel || x.owner !== sel.owner || x.idx !== sel.idx));
        if (s) target(s);
      }
      return this.poke();
    }
    if (step === 'queen') {
      const seen = v.peeks.find((k) => v.turn.qt && k.owner === v.turn.qt.owner && k.idx === v.turn.qt.idx);
      const w = worstOwn();
      if (seen && w && VALUE[seen.card.rank] < w.val) this.act({ a: 'queen', swap: true, owner: this.pid, idx: w.s.idx, ver: w.s.ver });
      else this.act({ a: 'queen', swap: false });
    }
  }

  // Our own move is under way (holding a drawn card, or using a power): no matching meanwhile.
  busy(v) { return v.activeId === this.pid && v.turn && ['choose', 'power', 'queen'].includes(v.turn.step); }

  afterSwap() {
    // After a swap we know what we put down: record it under the new slot version.
    if (!this.rememberSwap) return;
    const me = this.game.view(this.pid).players.find((p) => p.id === this.pid);
    const s = me.slots[this.rememberSwap.idx];
    if (s && !s.empty) this.mem.set(s.ver, this.rememberSwap.card);
    this.rememberSwap = null;
  }

  destroy() { clearTimeout(this.timer); }
}

module.exports = { Bot, LEVELS };
