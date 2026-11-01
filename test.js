'use strict';
// Engine acceptance tests: node test.js
const assert = require('assert');
const { Game } = require('./engine');
const { Bot } = require('./bot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Ben' }, { id: 'c', name: 'Cat' }, { id: 'd', name: 'Dan' }];
const C = (rank, suit = 'S') => ({ id: rank + suit, rank, suit });
let n = 0;
const ok = (r) => { assert.ok(!r.error, r.error); return r; };

// Build a game whose grids/deck we control. Cards not placed explicitly stay in the deck, so integrity holds.
function rig(mode, grids, opts = {}) {
  const g = new Game(P, mode, { matchMs: 300, giveMs: 300, graceMs: 200, pauseMs: 0, ...opts });
  const all = [...g.deck, ...g.discard, ...g.players.flatMap((p) => p.slots.map((s) => s.card))];
  const take = (id) => { const i = all.findIndex((c) => c.id === id); assert.ok(i >= 0, 'card ' + id); return all.splice(i, 1)[0]; };
  g.players.forEach((p, i) => { p.slots = grids[i].map((id) => (id ? g.slot(take(id)) : null)); });
  g.discard = [take(opts.top || '8D')];
  const deckTop = (opts.deckTop || []).map(take); // last element drawn first
  g.deck = [...all, ...deckTop];
  g.startIdx = 0;
  for (const p of P) g.handle(p.id, { a: 'ready' });
  assert.strictEqual(g.activeId, 'a');
  return g;
}
const sl = (g, pid, i) => g.p(pid).slots[i];
const closeWindow = (g) => { g.phase.open = false; g.maybeAdvance(); };
const tgt = (g, pid, i) => ({ owner: pid, idx: i, ver: sl(g, pid, i).ver });
const match = (g, by, pid, i) => g.handle(by, { a: 'match', phaseId: g.phase.id, ...tgt(g, pid, i), id: 'm' + ++n });
const G4 = [['AS', '2S', '3S', '4S'], ['5S', '6S', '7S', '8S'], ['9S', '10S', 'JS', 'QS'], ['AH', '2H', '3H', '4H']];

const tests = {
  'deal: 52 cards, 4 each, 36 in draw pile, empty discard'() {
    const g = new Game(P, 'FF');
    assert.strictEqual(g.deck.length, 36);
    assert.strictEqual(g.discard.length, 0, 'discard starts empty');
    g.players.forEach((p) => assert.strictEqual(p.slots.length, 4));
    assert.ok(g.integrity());
    g.destroy();
  },
  'hidden info: views contain no opponent card values'() {
    const g = new Game(P, 'FF');
    ok(g.handle('a', { a: 'view' }));
    assert.strictEqual(g.handle('a', { a: 'view' }).error, 'You already looked at your cards');
    const v = g.view('a');
    assert.strictEqual(v.peeks.length, 2);
    assert.deepStrictEqual(v.peeks.map((k) => k.idx), [2, 3]);
    const vb = JSON.stringify(g.view('b'));
    for (const s of g.p('a').slots) assert.ok(!vb.includes('"' + s.card.id + '"'));
    assert.strictEqual(g.view('b').peeks.length, 0);
    g.destroy();
  },
  'mandatory swap: Ace-6 cannot use power, swap discards replaced card'() {
    const g = rig('FF', G4, { deckTop: ['3D'] });
    ok(g.handle('a', { a: 'draw' }));
    assert.strictEqual(g.hand.id, '3D');
    assert.ok(g.handle('a', { a: 'usePower' }).error);
    assert.ok(g.handle('b', { a: 'swap', ...tgt(g, 'b', 0) }).error); // wrong player
    ok(g.handle('a', { a: 'swap', ...tgt(g, 'a', 1) }));
    assert.strictEqual(sl(g, 'a', 1).card.id, '3D');
    assert.strictEqual(g.top().id, '2S');
    assert.strictEqual(g.status, 'MATCHING_WINDOW');
    assert.ok(g.integrity());
    g.destroy();
  },
  '7+ goes face-up on the pile at once: everyone matches, then the drawer uses the power'() {
    const g = rig('MD', [['AS', '2S', '3S', '4S'], ['8C', '6S', '7S', '9S'], ['10S', 'JS', 'QS', 'KS'], ['AH', '2H', '3H', '4H']], { deckTop: ['8H'] });
    ok(g.handle('a', { a: 'draw' }));
    assert.strictEqual(g.top().id, '8H', 'revealed immediately');
    assert.strictEqual(g.status, 'MATCHING_WINDOW');
    for (const p of P) assert.strictEqual(g.view(p.id).discardTop.id, '8H', 'everyone sees it');
    assert.ok(g.handle('a', { a: 'swap', ...tgt(g, 'a', 0) }).error, 'cannot swap a power card');
    assert.ok(g.handle('a', { a: 'target', ...tgt(g, 'a', 0) }).error, 'power waits for the window');
    ok(match(g, 'b', 'b', 0)); // Ben matches his 8 in the same window
    assert.strictEqual(g.top().id, '8C');
    closeWindow(g);
    assert.strictEqual(g.activeId, 'a');
    assert.strictEqual(g.turn.step, 'power');
    ok(g.handle('a', { a: 'target', ...tgt(g, 'a', 0) }));
    assert.strictEqual(g.view('a').peeks[0].card.id, 'AS');
    assert.strictEqual(g.activeId, 'b', 'turn ends after the power, no second window');
    assert.ok(g.integrity());
    g.destroy();
  },
  'initial peek lasts until Ready, game starts when all ready'() {
    const g = new Game(P, 'FF');
    ok(g.handle('a', { a: 'view' }));
    assert.strictEqual(g.view('a').peeks.length, 2);
    ok(g.handle('a', { a: 'ready' }));
    assert.strictEqual(g.view('a').peeks.length, 0);
    for (const p of ['b', 'c', 'd']) ok(g.handle(p, { a: 'ready' }));
    assert.notStrictEqual(g.status, 'INITIAL_VIEWING');
    g.destroy();
  },
  'wrong match is revealed to everyone'() {
    const g = rig('MD', G4, { deckTop: ['5D'] });
    ok(g.handle('a', { a: 'draw' }));
    ok(g.handle('a', { a: 'swap', ...tgt(g, 'a', 0) })); // top AS
    ok(match(g, 'b', 'c', 1)); // 10S is wrong
    for (const p of P) assert.strictEqual(g.view(p.id).reveals[0].card.id, '10S');
    g.destroy();
  },
  'power 9 peeks opponent privately; no second action'() {
    const g = rig('FF', G4, { deckTop: ['9D'] });
    ok(g.handle('a', { a: 'draw' }));
    closeWindow(g);
    assert.ok(g.handle('a', { a: 'target', ...tgt(g, 'a', 0) }).error);
    ok(g.handle('a', { a: 'target', ...tgt(g, 'b', 3) }));
    assert.strictEqual(g.view('a').peeks[0].card.id, '8S');
    assert.strictEqual(g.view('b').peeks.length, 0);
    assert.strictEqual(g.top().id, '9D');
    assert.ok(g.handle('a', { a: 'draw' }).error);
    g.destroy();
  },
  'jack blind swap and king opponent swap keep positions'() {
    const g = rig('FF', G4, { deckTop: ['KD', 'JD'] });
    ok(g.handle('a', { a: 'draw' }));
    closeWindow(g);
    const first = tgt(g, 'a', 0);
    ok(g.handle('a', { a: 'target', ...first }));
    assert.ok(g.handle('a', { a: 'target', ...first }).error, 'same position twice');
    ok(g.handle('a', { a: 'target', ...tgt(g, 'c', 2) }));
    assert.strictEqual(sl(g, 'a', 0).card.id, 'JS');
    assert.strictEqual(sl(g, 'c', 2).card.id, 'AS');
    assert.strictEqual(g.view('a').peeks.length, 0);
    // King on next turn (b)
    ok(g.handle('b', { a: 'draw' }));
    closeWindow(g);
    assert.ok(g.handle('b', { a: 'target', ...tgt(g, 'b', 0) }).error, 'king cannot pick own');
    ok(g.handle('b', { a: 'target', ...tgt(g, 'c', 0) }));
    ok(g.handle('b', { a: 'target', ...tgt(g, 'c', 1) }));
    assert.strictEqual(sl(g, 'c', 0).card.id, '10S');
    assert.strictEqual(sl(g, 'c', 1).card.id, '9S');
    assert.ok(g.integrity());
    g.destroy();
  },
  'queen: inspect then decline or swap'() {
    const g = rig('FF', G4, { deckTop: ['QD'] });
    ok(g.handle('a', { a: 'draw' }));
    closeWindow(g);
    ok(g.handle('a', { a: 'target', ...tgt(g, 'd', 1) }));
    assert.strictEqual(g.turn.step, 'queen');
    ok(g.handle('a', { a: 'queen', swap: true, ...tgt(g, 'a', 3) }));
    assert.strictEqual(sl(g, 'a', 3).card.id, '2H');
    assert.strictEqual(sl(g, 'd', 1).card.id, '4S');
    g.destroy();
  },
  'matching own card leaves empty slot; wrong rank gives hidden penalty'() {
    const g = rig('MD', [['AS', '7C', '3S', '4S'], ['5S', '6S', '9C', '8S'], ['9S', '10S', 'JS', 'QS'], ['AH', '2H', '3H', '4H']], { deckTop: ['5D'] });
    ok(g.handle('a', { a: 'draw' }));
    ok(g.handle('a', { a: 'swap', ...tgt(g, 'a', 0) })); // discards AS
    ok(g.phase);
    // top is AS; Ben clicks 9C -> wrong
    ok(match(g, 'b', 'b', 2));
    assert.strictEqual(g.p('b').slots.length, 5);
    assert.strictEqual(sl(g, 'b', 2).card.id, '9C');
    assert.ok(!g.view('b').peeks.length, 'penalty not shown');
    // same card twice -> no second penalty
    assert.ok(match(g, 'b', 'b', 2).error);
    assert.strictEqual(g.p('b').slots.length, 5);
    // Dan matches own AH
    ok(match(g, 'd', 'd', 0));
    assert.strictEqual(sl(g, 'd', 0), null);
    assert.strictEqual(g.count(g.p('d')), 3);
    assert.ok(g.integrity());
    g.destroy();
  },
  'opponent match: replacement lands in same position, counts right'() {
    const g = rig('MD', [['AS', '7C', '3S', '4S'], ['5S', '6S', 'AC', '8S'], ['9S', '10S', 'JS', 'QS'], ['AH', '2H', '3H', '4H']], { deckTop: ['5D'] });
    ok(g.handle('a', { a: 'draw' }));
    ok(g.handle('a', { a: 'swap', ...tgt(g, 'a', 0) })); // top AS
    ok(match(g, 'c', 'b', 2)); // Cat takes Ben's AC
    assert.strictEqual(sl(g, 'b', 2), null);
    assert.strictEqual(g.count(g.p('b')), 4, 'reserved counts');
    assert.ok(g.handle('c', { a: 'give', ...tgt(g, 'c', 1) }).error === undefined);
    assert.strictEqual(sl(g, 'b', 2).card.id, '10S');
    assert.strictEqual(g.count(g.p('c')), 3);
    assert.strictEqual(g.count(g.p('b')), 4);
    assert.ok(g.integrity());
    g.destroy();
  },
  async 'multiple discard: several matches, timer not reset, late click rejected'() {
    const g = rig('MD', [['AS', '7C', '3S', '4S'], ['5S', '6S', 'AC', '8S'], ['9S', '10S', 'AD', 'QS'], ['AH', '2H', '3H', '4H']], { deckTop: ['5D'] });
    ok(g.handle('a', { a: 'draw' }));
    ok(g.handle('a', { a: 'swap', ...tgt(g, 'a', 0) }));
    const dl = g.phase.deadline;
    ok(match(g, 'b', 'b', 2));
    ok(match(g, 'c', 'c', 2));
    ok(match(g, 'd', 'd', 0));
    assert.strictEqual(g.phase.deadline, dl);
    assert.strictEqual(g.phase.matches, 3);
    const ph = g.phase.id;
    await sleep(700);
    assert.strictEqual(g.activeId, 'b');
    const r = g.handle('a', { a: 'match', phaseId: ph, ...tgt(g, 'a', 1), id: 'late' });
    assert.ok(r.error);
    assert.strictEqual(g.p('a').slots.length, 4, 'no penalty for late');
    g.destroy();
  },
  'fastest finger: one match, race loser penalised'() {
    const g = rig('FF', [['AS', '7C', '3S', '4S'], ['5S', '6S', 'AC', '8S'], ['9S', '10S', 'AD', 'QS'], ['AH', '2H', '3H', '4H']], { deckTop: ['5D'] });
    ok(g.handle('a', { a: 'draw' }));
    ok(g.handle('a', { a: 'swap', ...tgt(g, 'a', 0) }));
    const ph = g.phase.id;
    const stale = tgt(g, 'c', 2);
    ok(match(g, 'b', 'b', 2));
    assert.strictEqual(g.activeId, 'b', 'phase ended immediately, next turn');
    ok(g.handle('c', { a: 'match', phaseId: ph, ...stale, id: 'x1' }));
    assert.strictEqual(g.p('c').slots.length, 5, 'lost race -> penalty');
    assert.ok(g.handle('c', { a: 'match', phaseId: ph, ...stale, id: 'x2' }).error);
    assert.strictEqual(g.p('c').slots.length, 5, 'only one race penalty');
    assert.ok(g.integrity());
    g.destroy();
  },
  'duplicate action id has no second effect'() {
    const g = rig('MD', G4, { deckTop: ['5D'] });
    ok(g.handle('a', { a: 'draw' }));
    ok(g.handle('a', { a: 'swap', ...tgt(g, 'a', 0) }));
    const m = { a: 'match', phaseId: g.phase.id, ...tgt(g, 'b', 0), id: 'same' };
    ok(g.handle('b', m));
    assert.ok(g.handle('b', m).dup);
    assert.strictEqual(g.p('b').slots.length, 5);
    g.destroy();
  },
  async 'last card in window: locked now, auto CABO after window, one final turn each, scoring'() {
    const g = rig('FF', [['AS', '7C', '3S', '4S'], ['AC', null, null, null], ['9S', '10S', 'JS', 'QS'], ['AH', '2H', '3H', '4H']], { deckTop: ['4D', '5H', '6H', '5C', '2D'] });
    ok(g.handle('a', { a: 'draw' }));
    ok(g.handle('a', { a: 'swap', ...tgt(g, 'a', 0) })); // top AS
    ok(match(g, 'b', 'b', 0));
    assert.ok(g.p('b').locked);
    assert.strictEqual(g.status, 'MATCHING_WINDOW', 'window continues');
    // FF restriction still applies: Dan's AH now loses the race
    ok(match(g, 'd', 'd', 0));
    assert.strictEqual(g.p('d').slots.length, 5);
    await sleep(700);
    assert.strictEqual(g.caboCaller, 'b');
    assert.strictEqual(g.status, 'FINAL_TURNS');
    assert.strictEqual(g.activeId, 'c');
    assert.deepStrictEqual(g.queue, ['d', 'a']);
    assert.ok(g.handle('c', { a: 'cabo' }).error);
    for (const pid of ['c', 'd', 'a']) {
      assert.strictEqual(g.activeId, pid);
      ok(g.handle(pid, { a: 'draw' }));
      ok(g.handle(pid, { a: 'swap', ...tgt(g, pid, 1) }));
      g.phase.open = false; g.maybeAdvance();
    }
    assert.strictEqual(g.status, 'GAME_OVER');
    const r = g.results;
    assert.strictEqual(r.players[0].id, 'b');
    assert.strictEqual(r.players[0].total, 0);
    assert.ok(g.integrity());
    g.destroy();
  },
  'manual CABO: caller locked & untargetable; others get one turn'() {
    const g = rig('MD', G4, { deckTop: ['5H', '5D', '5C'] });
    ok(g.handle('a', { a: 'cabo' }));
    assert.ok(g.p('a').locked);
    assert.strictEqual(g.activeId, 'b');
    ok(g.handle('b', { a: 'draw' }));
    ok(g.handle('b', { a: 'swap', ...tgt(g, 'b', 0) }));
    const r = match(g, 'c', 'a', 0);
    assert.ok(/locked/.test(r.error));
    assert.strictEqual(g.p('c').slots.length, 4, 'no penalty for locked click');
    g.phase.open = false; g.maybeAdvance();
    assert.strictEqual(g.activeId, 'c');
    g.destroy();
  },
  'scoring: four of a kind = -4, penalties disqualify, ties declared'() {
    const g = rig('FF', [['KS', 'KH', 'KD', 'KC'], ['7S', '7H', '7D', '7C'], ['AS', '3S', '5S', 'QS'], ['AH', '3H', '5H', 'QH']]);
    g.endGame();
    const t = Object.fromEntries(g.results.players.map((p) => [p.id, p.total]));
    assert.deepStrictEqual(t, { a: -4, b: -4, c: 19, d: 19 });
    assert.ok(g.results.tie);
    const g2 = rig('FF', [['KS', 'KH', 'KD', 'KC'], ['7S', '7H', '7D', '7C'], ['AS', '3S', '5S', 'QS'], ['AH', '3H', '5H', 'QH']]);
    g2.p('a').slots.push(g2.slot(g2.deck.pop()));
    g2.endGame();
    assert.ok(g2.results.players.find((p) => p.id === 'a').total > 40);
    g.destroy(); g2.destroy();
  },
  'reshuffle keeps top discard, loses/duplicates nothing'() {
    const g = rig('MD', G4, { deckTop: ['5H'] });
    const pile = g.deck.splice(0, g.deck.length - 1);
    g.discard = [...pile, g.discard[0]];
    const top = g.top().id;
    ok(g.handle('a', { a: 'draw' }));
    ok(g.handle('a', { a: 'swap', ...tgt(g, 'a', 0) }));
    assert.strictEqual(g.deck.length, 0);
    ok(match(g, 'b', 'b', 0)); // wrong -> penalty requires reshuffle
    assert.strictEqual(g.discard.length, 1);
    assert.strictEqual(g.top().id, 'AS');
    assert.ok(g.deck.every((c) => c.id !== 'AS'));
    // the old top went back into the draw pile — unless it was the very card dealt as the penalty
    const dealt = g.p('b').slots.some((x) => x && x.card.id === top);
    assert.ok(g.deck.some((c) => c.id === top) || dealt, 'old top recycled');
    assert.ok(g.integrity());
    g.destroy();
  },
  async 'bots play a full game to completion with integrity'() {
    for (const mode of ['FF', 'MD']) {
      const g = new Game(P.map((p) => ({ ...p, isBot: true })), mode, { matchMs: 60, giveMs: 60, pauseMs: 0 });
      const bots = P.map((p, i) => new Bot(g, p.id, ['easy', 'medium', 'hard', 'hard'][i]));
      bots.forEach((b) => { b.poke = function () { if (!this.timer && !g.dead) this.timer = setTimeout(() => { this.timer = null; this.think(); }, 5); }; });
      g.onUpdate = () => { assert.ok(g.integrity(), 'integrity'); bots.forEach((b) => b.poke()); };
      bots.forEach((b) => b.poke());
      const t0 = Date.now();
      while (g.status !== 'GAME_OVER' && Date.now() - t0 < 60000) await sleep(20);
      assert.strictEqual(g.status, 'GAME_OVER', mode + ' finished');
      bots.forEach((b) => b.destroy()); g.destroy();
    }
  },

  async 'any table size from 2 to 6 players plays to the end'() {
    for (const n of [2, 3, 5, 6]) {
      const ps = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, isBot: true }));
      const g = new Game(ps, n % 2 ? 'MD' : 'FF', { matchMs: 60, giveMs: 60, pauseMs: 0 });
      assert.strictEqual(g.deck.length, 52 - 4 * n, `${n} players: 4 cards each`);
      const bots = ps.map((p) => new Bot(g, p.id, 'hard'));
      bots.forEach((b) => { b.poke = function () { if (!this.timer && !g.dead) this.timer = setTimeout(() => { this.timer = null; this.think(); }, 5); }; });
      g.onUpdate = () => { assert.ok(g.integrity(), 'integrity'); bots.forEach((b) => b.poke()); };
      bots.forEach((b) => b.poke());
      const t0 = Date.now();
      while (g.status !== 'GAME_OVER' && Date.now() - t0 < 60000) await sleep(20);
      assert.strictEqual(g.status, 'GAME_OVER', n + ' players finished');
      assert.strictEqual(g.results.players.length, n);
      bots.forEach((b) => b.destroy()); g.destroy();
    }
  },
};

(async () => {
  let fail = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n    ', e.message); }
  }
  console.log(fail ? `\n${fail} failed` : '\nAll passed');
  process.exit(fail ? 1 : 0);
})();
