'use strict';
// "How to play": a mini table that plays itself, one idea at a time, for someone who has never
// played. Each step has a headline, a plain-language line, a highlight on the thing being talked
// about, and the game's own sounds. Previous / Pause / Next let people go at their own speed.
// Reuses the game's card, flight and sticky-hand animations from app.js.
(function () {
  const C = (id) => ({ id, rank: id.slice(0, -1), suit: id.slice(-1) });
  const STEPS = 10;
  let run = 0;        // bumping this cancels a running demo
  let paused = false; // Pause button
  let skip = false;   // Next button: finish the current step at once
  let cur = 0;        // the step on screen

  const slotHTML = (id, pen) => `<div class="slot${pen ? ' pen' : ''}"><div class="card"><div class="face back"></div><div class="face front">${id ? faceHTML(C(id)) : ''}</div></div></div>`;
  const seatHTML = (who, name, cards) => `<div class="d-seat d-${who}"><div class="d-name">${name}</div>
    <div class="d-row"><div class="d-grid">${cards.map((c) => slotHTML(c)).join('')}</div><div class="d-pen"></div></div></div>`;

  function stageHTML() {
    return `<div class="d-head"><div class="d-cap" id="dCap"></div><div class="d-sub" id="dSub"></div></div>
      <div class="d-table">
        ${seatHTML('top', 'Bo', ['KC', '7S', '2D', '9H'])}
        ${seatHTML('left', 'Ann', ['QD', '4S', 'KH', '8C'])}
        <div class="d-center"><div class="pile d-draw"><div class="face back"></div><div class="face back"></div></div><div class="pile d-discard"><div class="face"></div></div></div>
        ${seatHTML('right', 'Cat', ['3C', 'JS', '6D', '10H'])}
        <div class="d-me-wrap">${seatHTML('me', 'You', ['QS', 'KS', 'AH', '3D'])}<div class="d-hold"></div>
          <button class="cabo-hold d-cabo hidden" tabindex="-1"><span class="ring"></span><span class="ic">CABO</span></button></div>
        <div class="d-key hidden"></div>
        <div class="d-burst"><span>CABO!</span></div>
      </div>
      <div class="d-foot">
        <div class="d-nav">
          <button class="d-arrow" data-do="demoPrev" title="Previous step (← key)" aria-label="Previous step" disabled>←</button>
          <div class="d-dots">${'<span></span>'.repeat(STEPS)}</div>
          <button class="d-arrow" data-do="demoNext" title="Next step (→ key)" aria-label="Next step">→</button>
        </div>
        <div class="row">
          <button class="btn small white" data-do="demoPause">Pause</button>
          <button class="btn small white" data-do="demoReplay">Replay</button>
          <button class="btn small white" data-do="rulesText">Full rules</button>
        </div></div>`;
  }

  window.openDemo = function () {
    openModal('demo', '<div class="demo"></div>');
    play();
  };
  window.playDemo = () => play(0);
  window.demoCtl = {
    pause(b) { paused = !paused; if (b) b.textContent = paused ? 'Play' : 'Pause'; },
    next() { skip = true; paused = false; const b = document.querySelector('[data-do=demoPause]'); if (b) b.textContent = 'Pause'; },
    prev() { play(Math.max(0, cur - 1)); },
  };

  // Each step builds on the table the steps before it left, so going back replays the demo from the
  // top: steps before `from` run instantly and silently (no flights, sounds or waits), then it plays.
  async function play(from = 0) {
    const token = ++run;
    paused = false; skip = false;
    let fast = from > 0;
    const demo = document.querySelector('.demo');
    if (!demo) return;
    demo.innerHTML = stageHTML();
    const q = (s) => demo.querySelector(s);
    const alive = () => token === run && demo.isConnected;
    // waits that respect Pause, and end early when Next is pressed
    const wait = (ms) => (fast ? (alive() ? Promise.resolve() : Promise.reject('stop')) : new Promise((res, rej) => {
      let left = ms, last = performance.now();
      const tick = () => {
        if (!alive()) return rej('stop');
        const now = performance.now();
        if (!paused) left -= now - last;
        last = now;
        if (skip || left <= 0) return res();
        setTimeout(tick, 50);
      };
      tick();
    }));
    const later = (ms, fn) => (fast ? fn() : setTimeout(() => alive() && fn(), ms));
    const fly = (...a) => { if (!fast) flyCard(...a); };
    const hand = (...a) => { if (!fast) stickyHand(...a); };
    const seat = (who) => q('.d-' + who);
    const slot = (who, i) => seat(who).querySelectorAll('.d-grid .slot')[i];
    const avatar = (who) => seat(who).querySelector('.d-name');
    const pile = q('.d-discard'), deck = q('.d-draw'), hold = q('.d-hold');
    const setPile = (id) => { pile.innerHTML = `<div class="face front">${faceHTML(C(id))}</div>`; };
    const setFace = (el, id) => { el.querySelector('.front').innerHTML = faceHTML(C(id)); };
    const sound = (name) => { if (fast) return; try { sfx[name](); } catch {} };
    const say = (title, sub = '') => {
      const c = q('.d-cap'), d = q('.d-sub');
      c.textContent = title; d.textContent = sub;
      for (const el of [c, d]) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
    };
    const sub = (text) => { const d = q('.d-sub'); d.textContent = text; d.classList.remove('pop'); void d.offsetWidth; d.classList.add('pop'); };
    // highlight what the words are about
    const focus = (...els) => { demo.querySelectorAll('.d-focus').forEach((e) => e.classList.remove('d-focus')); els.forEach((e) => e && e.classList.add('d-focus')); };
    const key = (html) => { const k = q('.d-key'); k.innerHTML = html || ''; k.classList.toggle('hidden', !html); };
    const step = (n) => {
      cur = n; skip = false;
      if (n >= from) fast = false;
      [...q('.d-dots').children].forEach((d, i) => d.classList.toggle('on', i <= n));
      q('[data-do=demoPrev]').disabled = n === 0;
    };

    try {
      // 1 — the table
      step(0);
      say('Welcome to CABO', '2 to 6 players. Everyone gets four cards, face down.');
      focus(seat('top'), seat('left'), seat('right'), seat('me'));
      await wait(4500);

      // 2 — the goal and card values
      step(1);
      say('Goal: the lowest total', 'Every card is worth points. At the end, the lowest total wins.');
      focus();
      key('<b>Card points</b><div>A = −1</div><div>2 to 10 = their number</div><div>J = 11 · Q = 12 · K = 13</div>');
      await wait(5500);
      key(null);

      // 3 — the one-time peek
      step(2);
      say('Peek at your bottom two', 'At the start you may look at these two cards, once.');
      focus(seat('me'));
      await wait(2000);
      sound('peek');
      slot('me', 2).classList.add('up', 'peek'); slot('me', 3).classList.add('up', 'peek');
      sub('An Ace (−1) and a 3. Remember them!');
      await wait(4000);
      slot('me', 2).classList.remove('up', 'peek'); slot('me', 3).classList.remove('up', 'peek');
      sub('Now they are face down again. The game is about memory.');
      await wait(3500);

      // 4 — drawing and swapping
      step(3);
      say('Your turn: draw a card', 'Take the top card from the deck.');
      focus(deck);
      deck.classList.add('tapme');
      await wait(2500);
      deck.classList.remove('tapme');
      sound('draw');
      hold.innerHTML = `<div class="face front">${faceHTML(C('5H'))}</div>`;
      fly(deck, hold, C('5H'), { ms: 900, arc: -50, spin: -10, flip: 'up' });
      focus(hold);
      sub('You drew a 5.');
      await wait(2500);
      say('Low cards go into your hand', 'Cards A to 6 must be swapped in. Swap out a card you think is high.');
      const target = slot('me', 1);
      focus(target);
      target.classList.add('sel');
      await wait(4000);
      target.classList.remove('sel');
      sound('whoosh');
      fly(target, pile, C('KS'), { ms: 1100, arc: -80, spin: 18, flip: 'up' });
      setPile('KS');
      fly(hold, target, null, { delay: 500, ms: 900, arc: 30, spin: -8 });
      setFace(target, '5H');
      later(500, () => { hold.innerHTML = ''; });
      sub('It was a King (13 points). It goes face up on the pile.');
      later(1200, () => focus(pile));
      await wait(4500);

      // 5 — matching
      step(4);
      say('Matching', 'When a card lands on the pile, anyone can throw in a card with the same number.');
      focus(pile);
      await wait(5000);
      sub('Ann remembers that Bo has a King…');
      focus(slot('top', 0), avatar('left'));
      await wait(2500);
      hand(avatar('left'), slot('top', 0), { via: pile, card: C('KC'), color: '#2ee6d6' });
      setPile('KC');
      later(500, () => slot('top', 0).classList.add('empty'));
      later(1050, () => sound('match'));
      later(1100, () => focus(pile));
      await wait(1600);
      sub('Match! Ann grabbed it, so that King is gone.');
      await wait(3500);

      // 6 — giving a card back
      step(5);
      say('Took someone else\'s card?', 'Then you give them one of yours, so they still have four.');
      focus(seat('left'), seat('top'));
      await wait(2500);
      sound('whoosh');
      hand(avatar('left'), slot('left', 1), { via: slot('top', 0), color: '#2ee6d6' });
      later(450, () => slot('left', 1).classList.add('empty'));
      later(1000, () => slot('top', 0).classList.remove('empty'));
      await wait(3500);
      sub('Ann now has one card less. Fewer cards usually means fewer points.');
      await wait(3500);

      // 7 — wrong guesses
      step(6);
      say('Careful: wrong guesses cost you', 'Cat taps a card that is not a King…');
      focus(seat('right'));
      await wait(2500);
      hand(avatar('right'), slot('top', 1), { miss: true, color: '#9bf34a' });
      later(380, () => { slot('top', 1).classList.add('up', 'revealed'); sound('buzz'); focus(slot('top', 1)); });
      await wait(2000);
      sub('It was a 7, and now everyone has seen it.');
      await wait(3000);
      sub('Cat also takes an extra penalty card. It adds to Cat\'s score.');
      const pen = document.createElement('div');
      pen.innerHTML = slotHTML(null, true);
      const penSlot = pen.firstChild;
      seat('right').querySelector('.d-pen').appendChild(penSlot);
      sound('boop');
      fly(deck, penSlot, null, { ms: 1000, arc: -60 });
      focus(penSlot);
      await wait(4000);
      slot('top', 1).classList.remove('up', 'revealed');

      // 8 — power cards
      step(7);
      say('High cards have powers', 'Cards 7 to K go straight onto the pile. Then you use their power.');
      focus(deck, pile);
      sound('whoosh');
      fly(deck, pile, C('9D'), { ms: 1000, arc: -80, spin: -14, flip: 'up' });
      setPile('9D');
      await wait(4500);
      key('<b>Powers</b><div>7, 8 — look at one of your cards</div><div>9, 10 — look at someone else\'s card</div><div>J — swap one of yours with any card</div><div>Q — look at a card, then maybe swap it</div><div>K — swap two other players\' cards</div>');
      focus();
      sub('Here is what each one does.');
      await wait(6000);
      key(null);
      sub('Bo drew this 9, so Bo looks at one of your cards. Only Bo sees it.');
      focus(slot('me', 0));
      await wait(2000);
      hand(avatar('top'), slot('me', 0), { color: '#ff86c2' });
      later(380, () => { slot('me', 0).classList.add('flash'); sound('peek'); });
      await wait(3500);
      slot('me', 0).classList.remove('flash');

      // 9 — calling CABO
      step(8);
      say('Think you have the lowest total?', 'At the start of your turn, press and hold CABO.');
      const cabo = q('.d-cabo');
      cabo.classList.remove('hidden');
      focus(cabo);
      await wait(3000);
      cabo.classList.add('holding');
      await wait(1200);
      cabo.classList.remove('holding');
      cabo.classList.add('hidden');
      sound('cabo');
      q('.d-burst').classList.add('show');
      await wait(2000);
      q('.d-burst').classList.remove('show');
      sub('Everyone else gets one last turn, then the round ends.');
      focus();
      await wait(4000);

      // 10 — scoring
      step(9);
      say('Then everyone shows their cards', 'Add up the points. The lowest total wins.');
      focus(seat('me'));
      sound('reveal');
      for (let i = 0; i < 4; i++) later(i * 250, () => slot('me', i).classList.add('up'));
      await wait(1500);
      const total = document.createElement('div');
      total.className = 'd-total';
      total.textContent = '12 + 5 − 1 + 3 = 19';
      seat('me').appendChild(total);
      await wait(4500);
      say('That\'s the game!', 'Remember cards, match fast, and call CABO at the right moment.');
      sound('win');
      focus();
      q('[data-do=demoReplay]').classList.add('pink');
    } catch (e) {
      if (e !== 'stop') console.error(e);
    }
  }
})();
