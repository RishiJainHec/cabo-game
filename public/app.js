'use strict';
// CABO browser client. The server is the source of truth; this file only renders the view it
// sends and forwards clicks. Hidden card values never reach this page unless you're allowed to see them.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
const PIP = { J: '♞', Q: '♛', K: '♚' };
const VAL = { A: -1, J: 11, Q: 12, K: 13 };
const val = (r) => VAL[r] ?? Number(r);
const an = (r) => (r === 'A' || r === '8' ? 'an ' : 'a ') + r;
const POWER = { A: 'swap', 2: 'swap', 3: 'swap', 4: 'swap', 5: 'swap', 6: 'swap', 7: 'peekOwn', 8: 'peekOwn', 9: 'peekOpp', 10: 'peekOpp', J: 'blindSwap', Q: 'queen', K: 'kingSwap' };
const PTAG = { swap: 'SWAP', peekOwn: 'PEEK', peekOpp: 'SPY', blindSwap: 'BLIND', queen: 'QUEEN', kingSwap: 'KING' };
const COLORS = ['#ffd23f', '#2ee6d6', '#ff86c2', '#9bf34a', '#ff8a3d', '#b69cff'];
const MODE_NAME = { FF: 'Fastest Finger', MD: 'Multiple Discard' };

let ws = null;
let V = null;           // latest authoritative view
let offset = 0;         // server clock - local clock
let session = load();
let muted = localStorage.getItem('cabo.muted') === '1';
const local = { sel: null, queenSwap: false, holdTimer: null, clicked: new Set(), turnKey: '', resultsShown: false, gameId: null };
const fxQueue = [];
let fxHold = 0; // ms the remaining effects of this update wait for

function load() { try { return JSON.parse(sessionStorage.getItem('cabo.session')); } catch { return null; } }
function save(s) { session = s; try { s ? sessionStorage.setItem('cabo.session', JSON.stringify(s)) : sessionStorage.removeItem('cabo.session'); } catch {} }
const snow = () => Date.now() + offset;
const rid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// ---------------- connection ----------------
function connect() {
  ws = window.CABO_OFFLINE ? window.CABO_OFFLINE.connect() : new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => {
    $('#conn').classList.add('hidden');
    if (session) send({ type: 'rejoin', code: session.code, token: session.token });
    else show();
  };
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
  ws.onclose = () => { $('#conn').classList.toggle('hidden', !session); setTimeout(connect, 1200); };
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function act(a, extra = {}) { send({ type: 'act', a, id: rid(), ...extra }); }

function onMsg(m) {
  if (m.type === 'joined') {
    save({ code: m.code, token: m.token, name: m.name });
    setUrl('?room=' + m.code);
    local.homeStep = window.CABO_OFFLINE ? 'solo' : 'pick'; // where Leave takes you back to
  } else if (m.type === 'gone') {
    save(null); V = null; show(); toast('That game is no longer available.', 'bad');
  } else if (m.type === 'kicked') {
    save(null); V = null; show(); toast('The host removed you from the room.', 'bad');
  } else if (m.type === 'error') {
    toast(m.msg, 'bad'); sfx.nope();
  } else if (m.type === 'note') {
    toast(m.msg);
  } else if (m.type === 'state') {
    V = m.view;
    offset = V.now - Date.now();
    show();
    // an effect that takes the stage (the reshuffle) pushes the card flights that follow it back
    fxHold = 0;
    while (fxQueue.length) runFx(fxQueue.shift());
    fxHold = 0;
  } else if (m.type === 'event') {
    fxQueue.push(m.ev);
  }
}

// ---------------- helpers on the view ----------------
const player = (id) => V.players.find((p) => p.id === id);
const nameOf = (id) => (player(id) || {}).name || '?';
const colorOf = (id) => COLORS[V.players.findIndex((p) => p.id === id) % COLORS.length];
const isMe = (id) => V && id === V.you;
// The rank whose power is in play: a private A–6 in hand, or a 7–K already face-up on the pile.
const powerRank = () => (V.hand ? V.hand.rank : V.turn && V.turn.power);
const ownTurn = () => V.activeId === V.you;

function visiblePeeks() { const t = snow(); return (V.peeks || []).filter((k) => k.until > t); }
function visibleReveals() { const t = snow(); return (V.reveals || []).filter((k) => k.until > t); }
const at = (list, owner, idx, s) => list.find((x) => x.owner === owner && x.idx === idx && x.ver === s.ver);
// What this player may see of a slot: final reveal, a wrong-match reveal (public), or their own peek.
function cardFor(owner, idx, s) {
  if (s.card) return { card: s.card };
  const r = at(visibleReveals(), owner, idx, s);
  if (r) return { card: r.card, revealed: true };
  const k = at(visiblePeeks(), owner, idx, s);
  return k ? { card: k.card, peek: true } : null;
}

// What does clicking a card do right now? Returns null when card clicks are disabled.
function interaction() {
  if (!V || !V.turn || V.status === 'GAME_OVER' || V.status === 'INITIAL_VIEWING') return null;
  const me = player(V.you);
  const own = (o) => o === V.you;
  const open = (o) => !player(o).locked;
  const give = V.phase && V.phase.gives.find((g) => g.attackerId === V.you);
  if (give) return { kind: 'give', ok: own };
  const t = V.turn;
  // A timed window pauses the game, so it's all there is to do. An open window runs alongside the
  // turns, except while you're in the middle of your own move (holding a drawn card, using a power).
  const busy = ownTurn() && ['choose', 'power', 'queen'].includes(t.step);
  if (V.phase && !busy) {
    const m = matchInteraction(me, open);
    if (m || !V.open) return m;
  }
  if (!ownTurn()) return null;
  if (t.step === 'choose') return V.hand && POWER[V.hand.rank] === 'swap' ? { kind: 'swap', ok: own } : null;
  if (t.step === 'queen') return local.queenSwap ? { kind: 'queenSwap', ok: own } : null;
  if (t.step !== 'power' || !powerRank()) return null;
  const sel = t.sel[0];
  const notSel = (o, i) => !sel || sel.owner !== o || sel.idx !== i;
  switch (POWER[powerRank()]) {
    case 'peekOwn': return { kind: 'target', ok: own };
    case 'peekOpp': case 'queen': return { kind: 'target', ok: (o) => !own(o) && open(o) };
    case 'blindSwap': return { kind: 'target', ok: sel ? (o, i) => open(o) && notSel(o, i) : own };
    case 'kingSwap': return { kind: 'target', ok: (o, i) => !own(o) && open(o) && notSel(o, i) };
  }
  return null;
}
// Matching the top discard. In an open window it's always on, so the cards aren't lit up ("quiet");
// the glowing discard says a match is possible.
function matchInteraction(me, open) {
  const ph = V.phase;
  if (me.locked) return null;
  // Fastest Finger: once someone has won the race, a late tap still goes through and costs a penalty
  if (V.mode === 'FF' && ph.matched) {
    if (ph.winnerId === V.you || (ph.lateUntil && snow() > ph.lateUntil)) return null;
    return { kind: 'match', ok: open, quiet: V.open };
  }
  if (!ph.open || (ph.deadline && snow() >= ph.deadline)) return null;
  return { kind: 'match', ok: open, quiet: V.open };
}
// Open window: the deck stays shut for a moment after each discard so everyone can match it.
const drawLocked = () => !!(V.open && V.phase && V.phase.open && snow() < V.phase.minUntil);
// The top discard can still be matched (open window).
const livePile = () => !!(V.open && V.phase && V.phase.open && !(V.mode === 'FF' && V.phase.matched));

// ---------------- screens ----------------
function show() {
  const scr = !V ? 'home' : V.status === 'LOBBY' ? 'lobby' : 'game';
  for (const id of ['home', 'lobby', 'game']) $('#' + id).classList.toggle('hidden', id !== scr);
  if (scr === 'home') renderHome();
  if (scr !== 'game') { resetTable(); closeTour(); }
  if (scr === 'lobby') renderLobby();
  if (scr === 'game') renderGame();
}

// Wipe every per-game DOM element and local selection so a new game starts from a clean table.
function resetTable() {
  if (local.gameId === null) return;
  for (const id of Object.keys(seats)) { seats[id].el.remove(); delete seats[id]; }
  for (const id of ['#drawPile', '#discardPile', '#handzone', '#actions']) { const el = $(id); if (el) { el.innerHTML = ''; el._h = null; } }
  cancelHold();
  Object.assign(local, { sel: null, queenSwap: false, clicked: new Set(), turnKey: '', resultsShown: false, gameId: null });
  closeModal('results');
  closeTour(); // a tournament's next round has begun
}

function renderHome() {
  const nm = $('#nameIn');
  if (!nm.value) nm.value = localStorage.getItem('cabo.name') || '';
  // an invite link (?room=CODE) opens straight on the join step with the code filled in
  const code = new URLSearchParams(location.search).get('room');
  if (code && !$('#codeIn').value) { $('#codeIn').value = code.toUpperCase(); local.homeStep ||= 'join'; }
  homeStep(local.homeStep || 'pick');
}

// The home card is one of three steps: pick (solo / host / join), solo setup, or join.
function homeStep(s) {
  local.homeStep = s;
  $('.home-card').dataset.step = s;
  if (s === 'solo') renderSolo();
}

// Solo picks are remembered, so a returning player just taps "Let's play!".
function soloPrefs() {
  const d = { players: 4, level: 'medium', mode: 'FF' };
  try { return { ...d, ...JSON.parse(localStorage.getItem('cabo.solo') || '{}') }; } catch { return d; }
}
function renderSolo() {
  const s = soloPrefs();
  const opt = (k, v, label) => `<button class="lvl ${s[k] === v ? 'on' : ''}" data-do="soloSet" data-k="${k}" data-v="${v}">${label}</button>`;
  setHTML($('#soloN'), [2, 3, 4, 5, 6].map((n) => opt('players', n, n)).join(''));
  setHTML($('#soloLvl'), [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']].map(([k, l]) => opt('level', k, l)).join(''));
  setHTML($('#soloMode'), opt('mode', 'FF', 'Fastest Finger') + opt('mode', 'MD', 'Multiple Discard'));
  const bots = s.players - 1;
  $('#soloHint').textContent = `You + ${bots} bot${bots > 1 ? 's' : ''} · ${s.mode === 'FF' ? 'only the first match counts' : 'match as many as you can'}`;
}

// Home screen story: the whole game in five tiny beats, told by a friendly card with a face on the
// big empty half of the screen. Huge words, one idea at a time, the real cards doing the moves.
const STORY = [
  { step: 'Get 4 cards', head: 'You get 4 cards', say: 'They stay face down. Secret, even from you!', color: 'var(--yellow)' },
  { step: 'Peek at 2', head: 'Peek at 2', say: 'Look at your bottom two, just once. Remember them!', color: 'var(--cyan)' },
  { step: 'Swap', head: 'Swap high for low', say: 'Draw a card. Got a small one? Swap it in!', color: 'var(--pink)' },
  { step: 'Lowest wins', head: 'Lowest total wins', say: 'Small numbers are good. An Ace is even −1!', color: 'var(--lime)' },
  { step: 'CABO!', head: 'Shout CABO!', say: 'Think you\'re the lowest? Hold CABO. Everyone else gets one last turn.', color: 'var(--red)' },
];
function homeStory() {
  const C = (id) => ({ id, rank: id.slice(0, -1), suit: id.slice(-1) });
  const card = (id) => `<div class="slot sc"><div class="card"><div class="face back"></div><div class="face front">${faceHTML(C(id))}</div></div><i class="val"></i></div>`;
  const st = document.createElement('div');
  st.className = 'story';
  st.innerHTML = `<div class="st-stage">
    <div class="st-steps">${STORY.map((b, i) => `<span style="--c:${b.color}"><b>${i + 1}</b>${b.step}<em></em></span>`).join('')}</div>
    <h1 class="st-head"></h1>
    <div class="st-glow"></div><div class="st-band"><span>you peek here</span></div>
    <div class="st-deck"><div class="slot sc"><div class="card"><div class="face back"></div></div></div></div>
    <div class="st-pile"></div>
    ${['KS', '5S', 'AH', '3C', '2D'].map(card).join('')}
    <div class="st-total"></div>
    <svg class="st-crown" viewBox="0 0 64 44"><path d="M4 40 L8 10 L22 24 L32 4 L42 24 L56 10 L60 40 Z"/><circle cx="8" cy="9" r="4"/><circle cx="32" cy="4" r="4"/><circle cx="56" cy="9" r="4"/></svg>
    <div class="st-rays"></div>
    <div class="cabo-hold st-cabo"><span class="ring"></span><span class="ic">CABO</span></div>
    <div class="st-boom">CABO!</div>
    <div class="st-mascot"><div class="m-face"><i class="m-eye"></i><i class="m-eye"></i><i class="m-mouth"></i></div></div>
    <div class="st-bubble"></div>
  </div>`;
  $('#home').prepend(st);
  const stage = st.firstElementChild;
  const q = (s) => stage.querySelector(s);
  const [kS, fS, aH, tC, dD] = [...stage.querySelectorAll('.st-stage > .sc')];
  // stage coordinates (the stage is 640x560 and scaled to fit)
  const SLOT = [[170, 150], [270, 150], [170, 290], [270, 290]], DECK = [450, 150], PILE = [450, 290], HAND = [540, 150];
  const put = (el, [x, y], rot = 0) => { el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.rotate = rot + 'deg'; };
  const flip = (el, up) => el.classList.toggle('up', up);
  const val = (el, v, bad) => { const i = el.querySelector('.val'); i.textContent = v; i.classList.toggle('bad', !!bad); el.classList.add('v'); };
  const mood = (m) => { q('.st-mascot').dataset.mood = m; };
  let token = 0;

  const fit = () => {
    const r = st.getBoundingClientRect();
    stage.style.setProperty('--s', Math.min(r.width / 640, r.height / 600, 1.6).toFixed(3));
  };
  addEventListener('resize', fit);

  async function run() {
    const my = ++token;
    const wait = (ms) => new Promise((res, rej) => setTimeout(() => (my === token ? res() : rej('stop')), ms));
    const beat = async (i) => {
      const b = STORY[i];
      stage.style.setProperty('--beat', b.color);
      [...q('.st-steps').children].forEach((s, k) => { s.classList.toggle('on', k === i); s.classList.toggle('done', k < i); });
      const h = q('.st-head'), bub = q('.st-bubble');
      h.textContent = b.head; bub.textContent = b.say;
      for (const el of [h, bub]) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
    };
    // wait while the home screen is hidden (in a game) or the window is too small to show the story
    const visible = () => !$('#home').classList.contains('hidden') && st.offsetWidth > 0 && !document.hidden;
    try {
      for (;;) {
        while (!visible()) await wait(800);
        fit();
        // reset: everything back on the deck
        stage.className = 'st-stage';
        for (const el of [kS, fS, aH, tC, dD]) { el.className = 'slot sc'; put(el, DECK); }
        mood('happy');
        await wait(400);

        await beat(0);
        stage.classList.add('dealt');
        [kS, fS, aH, tC].forEach((el, i) => setTimeout(() => { if (my === token) { el.classList.add('show'); put(el, SLOT[i], [-4, 3, 2, -3][i]); } }, 300 + i * 280));
        await wait(1800);
        [kS, fS, aH, tC].forEach((el, i) => put(el, SLOT[i]));
        await wait(2400);

        await beat(1);
        stage.classList.add('band');
        await wait(900);
        mood('wow');
        for (const el of [aH, tC]) { flip(el, true); el.classList.add('lifted'); }
        await wait(2800);
        for (const el of [aH, tC]) { flip(el, false); el.classList.remove('lifted'); }
        mood('happy');
        await wait(900);
        stage.classList.remove('band');

        await beat(2);
        dD.classList.add('show');
        await wait(500);
        put(dD, HAND, 6); flip(dD, true); val(dD, '2');
        await wait(1500);
        flip(kS, true); val(kS, '13', true); mood('worried');
        await wait(1600);
        put(kS, PILE, 10); kS.classList.remove('v');
        put(dD, SLOT[0]); dD.classList.remove('v');
        await wait(900);
        mood('happy');
        await wait(1100);
        flip(dD, false);
        await wait(700);

        await beat(3);
        kS.classList.remove('show'); // the King is gone, only your four cards count
        await wait(500);
        [[dD, '2'], [fS, '5'], [aH, '−1'], [tC, '3']].forEach(([el, v], i) => setTimeout(() => { if (my === token) { flip(el, true); val(el, v); } }, i * 330));
        await wait(1900);
        stage.classList.add('total'); q('.st-total').textContent = '= 9';
        mood('star');
        await wait(3400);

        await beat(4);
        for (const el of [dD, fS, aH, tC]) { flip(el, false); el.classList.remove('v'); }
        stage.classList.remove('total');
        stage.classList.add('cabo');
        await wait(900);
        stage.classList.add('holding');
        await wait(1300);
        stage.classList.add('boom'); mood('star');
        await wait(3600);
        stage.classList.add('out');
        await wait(700);
      }
    } catch (e) { if (e !== 'stop') console.error(e); }
  }
  run();
}

function avatar(name, color, cls = '') {
  return `<div class="avatar ${cls}" style="background:${color}">${esc((name || '?')[0].toUpperCase())}</div>`;
}

// When the host opened the game as localhost, friends can't use that address: swap in this
// computer's Wi-Fi address (asked from the server once).
let lanOrigin = null;
function inviteBase() {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || window.CABO_OFFLINE) return location.origin;
  if (lanOrigin === null) {
    lanOrigin = '';
    fetch('/lan.json').then((r) => r.json()).then((j) => {
      if (j.ips && j.ips.length) { lanOrigin = `${location.protocol}//${j.ips[0]}:${j.port}`; if (V && V.status === 'LOBBY') renderLobby(); }
    }).catch(() => {});
  }
  return lanOrigin || location.origin;
}

function renderLobby() {
  const host = V.hostId === V.you;
  const me = player(V.you);
  const link = inviteBase() + '/?room=' + V.code;
  const seats = [0, 1, 2, 3, 4, 5].map((i) => {
    const p = V.players[i];
    if (!p) {
      return `<div class="lseat empty"><div>Open seat</div>
        ${host ? '<button class="btn small white" data-do="addBot">Add bot</button>' : ''}</div>`;
    }
    const isHost = p.id === V.hostId;
    const status = !p.connected ? '<span class="pill off">offline</span>' : isHost ? '<span class="pill host">host</span>' : p.ready ? '<span class="pill ok">ready!</span>' : '<span class="pill wait">not ready</span>';
    return `<div class="lseat">
      ${host && !isHost ? `<button class="kick" data-do="kick" data-id="${p.id}" title="Remove">✕</button>` : ''}
      ${avatar(p.name, COLORS[i])}
      <div class="nm">${esc(p.name)}${p.id === V.you ? ' (you)' : ''}</div>${p.isBot ? '<span class="bot-tag">BOT</span>' : ''}
      <div>${status}</div></div>`;
  });
  const full = V.players.length >= 2; // enough to start (2 to 6 can play)
  const allReady = V.players.every((p) => p.ready);
  const modes = ['FF', 'MD'].map((m) => `<button class="mode ${V.mode === m ? 'on' : ''}" data-do="mode" data-mode="${m}" ${host ? '' : 'disabled'}>
      <h3>${m === 'FF' ? 'Fastest Finger' : 'Multiple Discard'}</h3>
      <p>${m === 'FF' ? 'Only the FIRST match counts. Lose the race? Penalty card!' : 'Match as many as you can. No race penalties.'}</p></button>`).join('');
  // Each part redraws only when its own content changes, so toggling the mode doesn't replay the player tiles.
  const card = $('#lobbyCard');
  if (!card.querySelector('#lbSeats')) card.innerHTML = '<div id="lbTop"></div><div class="seats4" id="lbSeats">' + '<div></div>'.repeat(6) + '</div><div id="lbModes"></div><div id="lbActions"></div>';
  setHTML($('#lbTop'), `<div class="lobby-top">
      <div><div class="muted">Room code</div><span class="code-chip">${esc(V.code)}</span></div>
      <div class="row" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn small cyan" data-do="copy" data-link="${esc(link)}">Copy invite link</button>
        <button class="btn small white" data-do="demo">How to play</button>
      </div>
    </div>`);
  // one holder per seat: only the seat that changed (e.g. a new bot) redraws and pops in
  seats.forEach((html, i) => setHTML($('#lbSeats').children[i], html));
  const levels = [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']].map(([k, label]) =>
    `<button class="lvl ${V.level === k ? 'on' : ''}" data-do="level" data-level="${k}" ${host ? '' : 'disabled'}>${label}</button>`).join('');
  setHTML($('#lbModes'), `<h3 style="margin-bottom:8px">Game mode ${host ? '' : '<span class="muted">(host picks)</span>'}</h3>
    <div class="modes">${modes}</div>
    ${V.players.some((p) => p.isBot) ? `<div class="levels"><h3>Bot level</h3><div class="lvl-row">${levels}</div></div>` : ''}
    ${tourSetupHTML(host)}`);
  setHTML($('#lbActions'), `<div class="lobby-actions">
      ${host
        ? `<button class="btn pink big" data-do="start" ${full && allReady ? '' : 'disabled'}>${V.tourOn ? 'Start tournament' : 'Start game'}</button>`
        : `<button class="btn big ${me.ready ? 'white' : 'lime'}" data-do="ready">${me.ready ? 'Not ready' : "I'm ready"}</button>`}
      <button class="btn white" data-do="leave">Leave</button>
    </div>
    <p class="muted" style="text-align:center;margin:12px 0 0">${!full ? 'Need at least one more player. Share the code or link, or add a bot!' : !allReady ? 'Waiting for everyone to be ready…' : host ? 'Everyone is ready. Hit start!' : 'Waiting for the host to start…'}</p>`);
}

// Tournament switch: several rounds with the same table, lowest running total wins.
const TROPHY = `<svg class="trophy" viewBox="0 0 24 24"><path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/><path d="M12 13v4M8 20h8M9.5 17h5"/></svg>`;
function tourSetupHTML(host) {
  const rounds = [5, 7, 10].map((n) =>
    `<button class="lvl ${V.tourRounds === n ? 'on' : ''}" data-do="tourRounds" data-n="${n}" ${host ? '' : 'disabled'}>${n}</button>`).join('');
  return `<div class="tour-box ${V.tourOn ? 'on' : ''}">
    <button class="tour-toggle" data-do="tourToggle" ${host ? '' : 'disabled'}>
      ${TROPHY}<span class="tt-txt"><b>Tournament</b><small>${V.tourOn ? `${V.tourRounds} rounds · lowest total wins` : 'Play several rounds, lowest total wins'}</small></span>
      <span class="switch"><i></i></span>
    </button>
    ${V.tourOn ? `<div class="tour-rounds"><span>Rounds</span><div class="lvl-row">${rounds}</div></div>` : ''}
  </div>`;
}

// ---------------- game rendering ----------------
// Where the other players sit, clockwise from your left, for each table size.
const SPOTS = {
  2: ['#spotTop'],
  3: ['#spotLeft', '#spotRight'],
  4: ['#spotLeft', '#spotTop', '#spotRight'],
  5: ['#spotLeft', '#spotTL', '#spotTR', '#spotRight'],
  6: ['#spotLeft', '#spotTL', '#spotTop', '#spotTR', '#spotRight'],
};
const ALL_SPOTS = ['#spotMe', '#spotLeft', '#spotTL', '#spotTop', '#spotTR', '#spotRight'];
const seats = {}; // pid -> {el, head, grid, pen, slots:{}}

function seatFor(pid) {
  let s = seats[pid];
  if (!s) {
    const el = document.createElement('div');
    el.className = 'seat';
    el.innerHTML = '<div class="seat-head"></div><div class="grid"></div><div class="penarea"></div>';
    s = seats[pid] = { el, head: el.children[0], grid: el.children[1], pen: el.children[2], slots: {} };
  }
  return s;
}

function setHTML(el, html) { if (el._h !== html) { el._h = html; el.innerHTML = html; } }

function faceHTML(c) {
  const red = c.suit === 'H' || c.suit === 'D';
  return `<div class="fc ${red ? 'red' : 'blk'}" data-id="${c.id}"><span class="crn">${c.rank}<i>${SUIT[c.suit]}</i></span>
    <span class="pip">${PIP[c.rank] || SUIT[c.suit]}</span><span class="ptag">${c.rank === 'A' ? '−1 pt' : PTAG[POWER[c.rank]]}</span>
    <span class="crn b">${c.rank}<i>${SUIT[c.suit]}</i></span></div>`;
}

// Shortest possible rule per power, shown on your drawn card and in the rules panel.
const TIP = {
  swap: 'Must swap in', peekOwn: 'Peek at one of yours', peekOpp: 'Spy on one of theirs',
  blindSwap: 'Swap one of yours with any card', queen: 'Spy, then maybe swap', kingSwap: 'Swap two of theirs',
};
const CHEAT = [['A–6', 'swap'], ['7 · 8', 'peekOwn'], ['9 · 10', 'peekOpp'], ['J', 'blindSwap'], ['Q', 'queen'], ['K', 'kingSwap']];

function renderGame() {
  if (V.gameId !== local.gameId) { local.gameId = 'x'; resetTable(); local.gameId = V.gameId; }
  const v = V;
  const t = v.turn || {};
  // reset local selections when the turn step changes
  const tk = `${v.activeId}|${t.step}|${v.phase ? v.phase.id : ''}`;
  if (tk !== local.turnKey) { local.turnKey = tk; local.sel = null; local.queenSwap = false; local.wantDraw = false; cancelHold(); }
  // Two clearly different moods: yellow while anyone may match, purple while the drawer uses a power.
  // An open window is always running, so it only makes the top discard glow.
  document.body.classList.toggle('matching', !v.open && !!(v.phase && v.phase.open));
  document.body.classList.toggle('livepile', livePile());
  document.body.classList.toggle('powering', (v.open || !v.phase) && v.status === 'AWAITING_ACTION' && !!(t.power));

  $('#roomChip').textContent = 'Room ' + v.code;
  $('#modeChip').textContent = MODE_NAME[v.mode];
  $('#modeChip').className = 'chip mode-' + v.mode.toLowerCase();
  $('#muteBtn').classList.toggle('off', muted);

  // seats around the table in turn order: you at the bottom, then left, across (top), right
  const myIdx = v.players.findIndex((p) => p.id === v.you);
  // everyone else clockwise from your left; which spots are used depends on how many play
  const n = v.players.length;
  const spots = ['#spotMe', ...SPOTS[n]];
  $('.table3').dataset.n = n;
  for (const sel of ALL_SPOTS) if (!spots.includes(sel)) $(sel).innerHTML = '';
  spots.forEach((sel, k) => {
    const p = v.players[(myIdx + k) % n];
    const s = seatFor(p.id);
    const spot = $(sel);
    if (s.el.parentNode !== spot) { spot.innerHTML = ''; spot.appendChild(s.el); }
    s.el.classList.toggle('me', k === 0);
    renderSeat(s, p, k === 0);
  });

  // CABO: a round button on your seat's corner that must be held down, so a stray tap does nothing
  let cb = $('#caboHold');
  if (!cb) {
    cb = document.createElement('button');
    cb.id = 'caboHold';
    cb.className = 'cabo-hold';
    cb.innerHTML = '<span class="ring"></span><span class="ic">CABO</span><span class="tip">Hold to call CABO</span>';
    cb.addEventListener('pointerdown', startHold);
    for (const e of ['pointerup', 'pointerleave', 'pointercancel']) cb.addEventListener(e, cancelHold);
    cb.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const meSeat = seats[v.you].el;
  if (cb.parentNode !== meSeat) meSeat.appendChild(cb);
  cb.classList.toggle('hidden', !(ownTurn() && t.step === 'draw' && !v.caboCaller && v.status !== 'GAME_OVER'));

  renderCenter();
  renderActions();
  renderCheat();
  renderBoard();

  fitTable();

  // a brand-new game (not a reload mid-peek): deal the cards out round the table
  if (v.status === 'INITIAL_VIEWING' && local.dealt !== v.gameId) {
    local.dealt = v.gameId;
    if (v.viewDeadline - snow() > 87000) { dealFx(); renderActions(); }
  }

  if (v.status === 'GAME_OVER' && !local.resultsShown) {
    local.resultsShown = true;
    // a tournament shows its podium (or, after the last round, the champion) instead of the round's scores
    setTimeout(() => { if (V && V.status === 'GAME_OVER') (V.tour ? showTour() : showResults()); }, 2200);
  }}

// Pick the largest card size at which the whole table fits the window, so no cards are ever cut off.
// Only real layout boxes are measured (seats, center, page height): badges, stamps, flying cards and
// animations are ignored, so a passing effect can't shrink the table. Runs on every update, so the
// cards also grow back whenever there's room again.
function fitTable() {
  if (!V || $('#game').classList.contains('hidden')) return;
  const root = document.documentElement;
  // Phones widen the page to fit oversized content, which defeats measuring; they use the CSS sizes and scroll.
  if (Math.min(screen.width, innerWidth) <= 760) { root.style.removeProperty('--cw'); return; }
  const boxes = [...ALL_SPOTS, '.table3 .center'].map((q) => $(q));
  // seats themselves (not their grid cells): a hand full of penalty cards can grow wider than its cell
  const seatEls = () => ALL_SPOTS.map((q) => $(q + ' .seat')).filter(Boolean);
  const hit = (a, b) => a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2;
  const fits = () => {
    if ($('#game').offsetHeight > innerHeight + 1) return false;
    const rs = [...boxes, ...seatEls()].map((el) => el.getBoundingClientRect());
    if (!rs.every((r) => r.left >= -1 && r.right <= innerWidth + 1)) return false;
    const ss = seatEls().map((el) => el.getBoundingClientRect());
    return ss.every((a, i) => ss.every((b, j) => j <= i || !hit(a, b)));
  };
  let lo = 24, hi = 96;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    root.style.setProperty('--cw', mid + 'px');
    if (fits()) lo = mid; else hi = mid;
  }
  root.style.setProperty('--cw', Math.floor(lo) + 'px');
}
addEventListener('resize', () => fitTable());
if (document.fonts) document.fonts.ready.then(() => fitTable());

function startHold(e) {
  e.preventDefault();
  unlockAudio();
  const cb = $('#caboHold');
  cb.classList.add('holding');
  local.holdTimer = setTimeout(() => { cb.classList.remove('holding'); act('cabo'); }, 1000);
}
function cancelHold() {
  clearTimeout(local.holdTimer);
  const cb = $('#caboHold');
  if (cb) cb.classList.remove('holding');
}

function renderSeat(s, p, me) {
  const v = V;
  const active = v.activeId === p.id && v.status !== 'GAME_OVER' && v.status !== 'INITIAL_VIEWING';
  s.el.classList.toggle('active', active);
  s.el.classList.toggle('locked', p.locked);
  s.el.classList.toggle('called', p.caller && v.status !== 'GAME_OVER');
  const badges = [
    p.exhausted ? '<span class="badge lock">OUT</span>' : p.locked && !p.caller ? '<span class="badge lock">LOCKED</span>' : '',
    !p.connected ? '<span class="badge off">offline</span>' : '',
    v.status === 'INITIAL_VIEWING' && p.ready ? '<span class="badge ok">✓</span>' : '',
  ].join('');
  const lead = tourLeaders().includes(p.id) ? `<span class="leadcrown" title="Tournament leader">${CROWN}</span>` : '';
  setHTML(s.head, `${lead}${avatar(p.name, colorOf(p.id), 'sm')}<div class="who"><div class="nm">${esc(p.name)}${me ? ' (you)' : ''}</div>
    <div class="badges">${badges}</div></div>`);

  const it = interaction();
  const over = v.status === 'GAME_OVER';
  const sel = (v.turn && v.turn.sel) || [];
  const qt = v.turn && v.turn.qt;
  p.slots.forEach((sl, idx) => {
    const pen = idx >= 4;
    let el = s.slots[idx];
    if (pen && sl.empty && !sl.reserved) { if (el) { el.remove(); delete s.slots[idx]; } return; }
    if (!el) {
      el = document.createElement('div');
      el.innerHTML = '<div class="card"><div class="face back"></div><div class="face front"></div></div>';
      el.dataset.owner = p.id;
      el.dataset.idx = idx;
      (pen ? s.pen : s.grid).appendChild(el);
      s.slots[idx] = el;
    }
    const seen = sl.empty ? null : cardFor(p.id, idx, sl);
    const card = seen && seen.card;
    const clickable = it && !sl.empty && it.ok(p.id, idx);
    const selected = (local.sel && local.sel.owner === p.id && local.sel.idx === idx) ||
      sel.some((x) => x.owner === p.id && x.idx === idx) || (qt && qt.owner === p.id && qt.idx === idx);
    const cls = ['slot', pen && 'pen', sl.empty && 'empty', sl.reserved && 'reserved', card && 'up', seen && seen.peek && 'peek',
      seen && seen.revealed && 'revealed', clickable && (it.quiet ? 'tappable' : 'elig'), clickable && it.kind === 'swap' && 'swaptarget', selected && 'sel', p.locked && !over && 'locked'].filter(Boolean).join(' ');
    el.className = cls + (el._keep && el._keep.size ? ' ' + [...el._keep].join(' ') : '');
    if (over) el.querySelector('.card').style.transitionDelay = (V.players.indexOf(p) * 4 + idx) * 70 + 'ms';
    const fk = card ? card.id : '';
    if (el._fk !== fk) { el._fk = fk; el.querySelector('.front').innerHTML = card ? faceHTML(card) : ''; }
  });
  for (const k of Object.keys(s.slots)) if (Number(k) >= p.slots.length) { s.slots[k].remove(); delete s.slots[k]; }
}

// Small stable tilt per card so the discard pile looks like a messy real pile.
const tilt = (id) => ([...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 21) - 10;

function renderCenter() {
  const v = V;
  const myDraw = ownTurn() && v.turn && v.turn.step === 'draw' && v.status !== 'GAME_OVER';
  const canDraw = myDraw && !drawLocked();
  const dp = $('#drawPile');
  setHTML(dp, v.draw > 0 ? '<div class="face back"></div><div class="face back"></div><div class="face back"></div>' : '<div class="face"></div>');
  dp.classList.toggle('empty', v.draw === 0);
  dp.classList.toggle('tapme', !!canDraw);
  dp.classList.toggle('waiting', !!myDraw && !canDraw);
  dp.classList.toggle('armed', !!myDraw && !canDraw && !!local.wantDraw);
  if (myDraw) dp.dataset.do = 'draw'; else delete dp.dataset.do;

  // discard: the last few cards stay visible, stacked with a little tilt
  const rec = v.discardRecent || [];
  setHTML($('#discardPile'), (rec.length ? rec.map((c, i) => {
    const topCard = i === rec.length - 1;
    return `<div class="face front" style="${topCard ? '' : `transform: rotate(${tilt(c.id)}deg) translate(${tilt(c.id) / 2}px, ${-i}px)`}">${faceHTML(c)}</div>`;
  }).join('') : '<div class="face"></div>'));
  $('#discardPile').classList.toggle('empty', !rec.length);

  // the drawn card sits next to whoever drew it. It only moves when someone new is holding a card:
  // the turn passes on in the same update as a swap, and the swapped card must fly from the
  // swapper's side, not from the next player's.
  let hz = $('#handzone');
  if (!hz) { hz = document.createElement('div'); hz.id = 'handzone'; hz.className = 'handzone idle'; }
  const holder = (v.hand || v.handHeld) && v.activeId && seats[v.activeId];
  if (holder) {
    const spot = holder.el.parentNode;
    if (hz.parentNode !== spot) spot.appendChild(hz);
    hz.dataset.side = spot.id;
  }
  if (v.hand) {
    local.lastHand = v.hand;
    hz.classList.remove('idle');
    setHTML(hz, `<div class="handcard"><div class="face front">${faceHTML(v.hand)}</div></div><div class="htip">${TIP[POWER[v.hand.rank]]}</div>`);
  } else if (v.handHeld) {
    hz.classList.remove('idle');
    setHTML(hz, '<div class="handcard ghost"><div class="face back"></div></div>');
  } else {
    hz.classList.add('idle');
  }
}

function btn(label, act, cls = '', extra = '') { return `<button class="btn ${cls}" data-do="${act}" ${extra}>${label}</button>`; }
const cap = (html) => `<div class="cap">${html}</div>`;

// The middle stays almost wordless: a short caption and, only when needed, a button.
function renderActions() {
  const v = V;
  const me = player(v.you);
  const t = v.turn || {};
  let h = '';
  if (v.status === 'INITIAL_VIEWING') {
    if (Date.now() < (local.dealUntil || 0)) h = cap('Dealing…');
    else if (!me.viewed) h = `${btn('Peek', 'view', 'pink big')}${cap('your bottom two cards, once')}`;
    else if (!me.ready) h = `${btn('Ready', 'viewReady', 'lime big')}${cap('memorise them')}`;
    else h = cap('Waiting for the others…');
  } else if (v.status === 'GAME_OVER' && v.tour && !v.tour.done) {
    h = cap(`Round ${v.tour.round + 1} is coming up…`);
  } else if (v.status === 'GAME_OVER' && v.tour) {
    h = `<div class="row">${btn('Standings', 'standings', 'pink')}${btn('Last round', 'results', 'white')}</div>`;
  } else if (v.status === 'GAME_OVER') {
    h = `<div class="row">${btn('Scores', 'results', 'white')}${soloTable() ? btn('Play again', 'again', 'pink') : btn('Back to lobby', 'rematch', 'pink')}</div>`;
  } else if (v.phase && v.phase.gives.some((g) => g.attackerId === v.you)) {
    const give = v.phase.gives.find((g) => g.attackerId === v.you);
    h = cap(`Give ${esc(nameOf(give.owner))} one of your cards`);
  } else if (v.status === 'LAST_CALL') {
    // a quiet few seconds to match the final discard; only the glowing pile says so
  } else if (v.phase && !v.open) {
    if (v.mode === 'FF' && v.phase.matched) h = cap(`${esc(nameOf(v.phase.winnerId))} got it`);
    else if (!me.locked) h = `<div class="matchcall">tap ${/^(A|8)$/.test(v.discardTop.rank) ? 'an' : 'a'} <b>${v.discardTop.rank}</b></div>`;
  } else if (ownTurn()) {
    if (t.step === 'draw') h = drawLocked() ? cap(local.wantDraw ? 'Drawing as soon as the deck opens…' : 'Deck opens in a sec… tap it to draw then') : cap(t.final ? 'Tap the deck · last turn' : 'Tap the deck');
    else if (t.step === 'choose') {
      h = cap('Click one of your cards to swap it');
    } else if (t.step === 'power') {
      h = t.sel.length ? `${cap('Now pick the second card')}${btn('↩', 'cancel', 'white small')}` : `<div class="powercall">${powerRank()} · ${TIP[POWER[powerRank()]]}</div>`;
    } else if (t.step === 'queen') {
      h = local.queenSwap
        ? `${cap('Pick one of yours')}${btn('←', 'queenBack', 'white small')}`
        : `<div class="row">${btn('Swap', 'queenSwap', 'lime big')}${btn('Keep', 'queenKeep', 'white big')}</div>`;
    } else if (v.status === 'RESOLVING' && visiblePeeks().length) {
      const pk = visiblePeeks()[0];
      h = cap(livePile() && pk.card.rank === v.phase.ref ? 'It matches! Tap it to match' : 'Got it? Tap the card to close it');
    }
  } else if (t.power && v.status === 'AWAITING_ACTION') {
    // someone else is using a power: say who and what, in a few words
    h = `<div class="powercall">${esc(nameOf(v.activeId))} · ${TIP[POWER[t.power]]}</div>`;
  } else if (livePile() && !me.locked) {
    h = `<div class="matchcall soft">got ${/^(A|8)$/.test(v.phase.ref) ? 'an' : 'a'} <b>${v.phase.ref}</b>? tap it</div>`;
  }
  setHTML($('#actions'), h);
}

// Rules side panel: the whole cheat sheet in a few words; the card you're holding lights up.
function renderCheat() {
  const p = V && V.turn && V.activeId === V.you && POWER[powerRank()];
  setHTML($('#cheatBody'), CHEAT.map(([r, k]) => `<div class="crow ${p === k ? 'on' : ''}"><b>${r}</b><span>${TIP[k]}</span></div>`).join('') +
    '<div class="cnote">Match = same rank<br>Wrong match = +1 card<br>CABO but not lowest = +10<br>Lowest total wins · A = −1</div>');
  // closed by default; until it's been opened once, the tab wiggles with a "Card powers!" bubble
  const open = localStorage.getItem('cabo.cheat') === '1';
  $('#cheat').classList.toggle('open', open);
  $('#cheat').classList.toggle('nudge', !open && localStorage.getItem('cabo.cheatSeen') !== '1');
  $('#game').classList.toggle('cheat-open', open);
}

// ---------------- tournament ----------------
const pts = (n) => (n < 0 ? '−' + -n : String(n));
const delta = (n) => (n < 0 ? pts(n) : '+' + n); // a round's points, signed
const CROWN = '<svg class="tcrown" viewBox="0 0 24 16"><path d="M2 14 L4 3 L9 9 L12 1 L15 9 L20 3 L22 14 Z"/></svg>';
// Everyone keeps their table colour, even after they've left.
const tourColor = (id) => { const i = V.players.findIndex((p) => p.id === id); return COLORS[(i < 0 ? V.tour.standings.findIndex((r) => r.id === id) : i) % COLORS.length]; };

// Who wears the crown on the table: whoever leads the tournament (all of them if tied), once at
// least one round has been scored.
function tourLeaders() {
  const T = V && V.tour;
  if (!T || !T.standings.some((r) => r.last != null)) return [];
  return T.standings.filter((r) => !r.left && r.place === 1).map((r) => r.id);
}

// The round chip in the top bar and the running leaderboard on the left (open unless closed by you).
function renderBoard() {
  const T = V.tour;
  $('#tourChip').classList.toggle('hidden', !T);
  $('#board').classList.toggle('hidden', !T);
  const open = !!T && localStorage.getItem('cabo.board') !== '0';
  $('#board').classList.toggle('open', open);
  $('#game').classList.toggle('board-open', open);
  if (!T) return;
  $('#tourChip').textContent = `Round ${T.round} of ${T.rounds}`;
  setHTML($('#boardHead'), `${TROPHY}<span>Leaderboard</span>`);
  setHTML($('#boardBody'), T.standings.map((r) => `<div class="brow ${r.id === V.you ? 'me' : ''} ${r.left ? 'gone' : ''}">
      <span class="bplace p${r.left ? 0 : r.place}">${r.left ? '–' : r.place}</span>
      <span class="bdot" style="background:${tourColor(r.id)}"></span>
      <span class="bname">${esc(r.name)}${r.wins ? `<i class="bwins" title="Rounds won">${CROWN}${r.wins}</i>` : ''}</span>
      <span class="btotal">${pts(r.total)}</span></div>`).join('') +
    `<div class="cnote">Lowest total after ${T.rounds} rounds wins</div>`);
}

// Full-screen tournament moments. Between rounds: the top three rise onto a podium, everyone else
// slides in below, and a bar counts down to the next round. After the last round: a drumroll, the
// podium builds from third place up, and the champion drops in with a crown and confetti.
// `instant` re-opens it without the build-up (the Standings button).
let tourTick = null;
function closeTour() { clearInterval(tourTick); tourTick = null; $('#tourfx')?.remove(); }
function showTour(instant = false) {
  const T = V && V.tour;
  if (!T || V.status !== 'GAME_OVER') return;
  closeTour();
  closeModal();
  const final = T.done;
  const live = T.standings.filter((r) => !r.left);
  const top = live.slice(0, 3);
  const champs = live.filter((r) => r.place === 1);
  // when things happen (seconds); the final makes you wait for first place
  const at = final ? { 3: 1.3, 2: 2.5, 1: 4.6, board: 6.4 } : { 3: 0.3, 2: 0.6, 1: 0.9, board: 1.7 };
  const podium = [[top[1], 2], [top[0], 1], [top[2], 3]].filter(([r]) => r).map(([r, spot]) => {
    const d = at[spot];
    return `<div class="pod pod${spot}" style="--d:${d}s">
      <div class="pod-who">
        ${r.place === 1 ? CROWN : ''}
        <div class="pod-av" style="background:${tourColor(r.id)}">${esc(r.name[0].toUpperCase())}</div>
        <div class="pod-name">${esc(r.name)}${r.id === V.you ? ' <small>(you)</small>' : ''}</div>
      </div>
      <div class="pod-col"><span class="pod-num">${r.place}</span>
        <b class="pod-total" data-from="${final ? 0 : r.total - (r.last || 0)}" data-to="${r.total}" data-at="${d + 0.45}">${pts(r.total)}</b><small>points</small>
        ${!final && r.last != null ? `<em class="pod-delta">${delta(r.last)}</em>` : ''}</div>
    </div>`;
  }).join('');
  // everyone below the podium (or, at the end, the whole table with rounds won)
  const list = (final ? T.standings : T.standings.slice(3)).filter((r) => final || !top.includes(r)).map((r, i) => `
    <div class="tq-row ${r.id === V.you ? 'me' : ''} ${r.left ? 'gone' : ''}" style="--d:${at.board + i * 0.12}s">
      <span class="bplace p${r.left ? 0 : r.place}">${r.left ? '–' : r.place}</span>
      <span class="bdot" style="background:${tourColor(r.id)}"></span>
      <span class="tq-name">${esc(r.name)}${r.left ? ' <small>left</small>' : ''}</span>
      ${final ? `<span class="tq-wins">${r.wins ? CROWN.repeat(Math.min(r.wins, 5)) + (r.wins > 5 ? `×${r.wins}` : '') : ''}</span>` : `<span class="tq-delta">${r.last != null ? delta(r.last) : ''}</span>`}
      <b>${pts(r.total)}</b></div>`).join('');
  const champName = champs.length > 1 ? champs.map((c) => esc(c.name)).join(' & ') : esc(champs[0] ? champs[0].name : '');
  const wait = Math.max(0, (T.nextAt || 0) - snow());
  const el = document.createElement('div');
  el.id = 'tourfx';
  el.className = (final ? 'final' : 'between') + (instant ? ' instant' : '');
  el.innerHTML = `<div class="tq">
    ${final
      ? `<div class="tq-intro">And the champion is<span class="dots"><i>.</i><i>.</i><i>.</i></span></div>
         <div class="tq-title champ" style="--d:${at[1] + 0.7}s">${champs.length > 1 ? 'Co-champions!' : 'Champion!'}<span>${champName}</span></div>`
      : `<div class="tq-title">Round ${T.round} of ${T.rounds}<span>Standings so far · lowest total leads</span></div>`}
    <div class="podium">${podium}</div>
    ${list ? `<div class="tq-list">${list}</div>` : ''}
    ${final
      ? `<div class="tq-actions" style="--d:${at.board + 0.6}s">${soloTable() ? btn('Play again', 'again', 'pink') : btn('Back to lobby', 'rematch', 'pink')}${btn('Last round', 'results', 'white')}${btn('Table', 'closeTour', 'white')}</div>`
      : `<div class="tq-next" style="--d:${at.board}s"><span>Round ${T.round + 1} starts in <b id="tqSec">${Math.ceil(wait / 1000)}</b></span>
           <div class="tq-bar"><i style="animation-duration:${wait}ms"></i></div></div>`}
  </div>`;
  document.body.appendChild(el);

  // numbers count up as each player lands; sounds follow the build-up
  const later = (s, fn) => setTimeout(() => el.isConnected && fn(), instant ? 0 : s * 1000);
  el.querySelectorAll('.pod-total').forEach((b) => {
    const from = +b.dataset.from, to = +b.dataset.to;
    if (instant || from === to) return;
    b.textContent = pts(from);
    later(+b.dataset.at, () => {
      const t0 = performance.now();
      const stepN = (t) => { const k = Math.min(1, (t - t0) / 700); b.textContent = pts(Math.round(from + (to - from) * k)); if (k < 1 && el.isConnected) requestAnimationFrame(stepN); };
      requestAnimationFrame(stepN);
    });
  });
  if (!instant) {
    for (const spot of [3, 2, 1]) if (el.querySelector('.pod' + spot)) { later(at[spot], () => sfx.rise()); later(at[spot] + 0.45, () => sfx.land()); }
    if (final) {
      later(at[2] + 0.9, () => sfx.drum());
      later(at[1] + 0.5, () => {
        sfx.win();
        el.querySelectorAll('.pod1 .pod-av').forEach((a) => { const [x, y] = center(a); confetti(x, y, 140); });
        confetti(innerWidth / 2, innerHeight / 4, 120);
      });
    }
  }
  if (!final) {
    tourTick = setInterval(() => {
      const s = $('#tqSec');
      const left = ((V && V.tour && V.tour.nextAt) || 0) - snow();
      if (s) s.textContent = Math.max(0, Math.ceil(left / 1000));
    }, 250);
  }
}

// ---------------- results ----------------
// You and only bots: the next round can start in one tap, same table and settings.
const soloTable = () => V.hostId === V.you && V.players.every((p) => p.id === V.you || p.isBot);

function showResults() {
  if (!V || !V.results) return;
  const r = V.results;
  const reopen = $('#modal').dataset.kind === 'results';
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][n] || 'th');
  const fmt = (n) => (n < 0 ? '−' + -n : String(n));
  const rows = r.players.map((p, i) => {
    const cards = p.cards.map((c) => `<div class="mcard ${c.card.suit === 'H' || c.card.suit === 'D' ? 'red' : ''} ${c.penalty ? 'pen' : ''}">
        <div class="mf">${c.card.rank}<i>${SUIT[c.card.suit]}</i></div><div class="mv">${fmt(val(c.card.rank))}</div></div>`).join('');
    const sum = p.four ? 'Four of a kind → <b>−4</b>'
      : p.cards.length ? p.cards.map((c) => (val(c.card.rank) < 0 ? `(${fmt(val(c.card.rank))})` : val(c.card.rank))).join(' + ') + ` = <b>${fmt(p.missed ? p.cardsTotal : p.total)}</b>`
      : 'No cards left → <b>0</b>';
    // called CABO but someone was lower: the extra points, spelled out
    const miss = p.missed ? ` · <span class="cabomiss">+${p.missed} CABO miss</span> → <b>${fmt(p.total)}</b>` : '';
    return `<div class="score-row ${r.winners.includes(p.id) ? 'win' : ''}" style="animation-delay:${i * 120}ms">
      <div class="place">${ord(p.place)}</div>
      <div><div class="nm">${esc(p.name)}${p.id === V.you ? ' (you)' : ''}${p.caller ? (p.missed ? '<span class="tagc miss">CABO MISS</span>' : '<span class="tagc">CALLED CABO</span>') : ''}${p.four ? '<span class="four">FOUR OF A KIND</span>' : ''}</div>
        <div class="mini-cards">${cards || '<span class="sum">—</span>'}</div><div class="sum">${sum}${miss}</div></div>
      <div class="total">${fmt(p.total)}<small>points</small></div></div>`;
  }).join('');
  const title = r.tie ? `It's a tie!` : r.winners[0] === V.you ? 'You win!' : `${esc(nameOf(r.winners[0]))} wins!`;
  openModal('results', `<h2>${title}</h2>
    <div class="lobby-actions res-actions">${soloTable() ? btn('Play again', 'again', 'pink') + btn('Change setup', 'rematch', 'white') : btn('Back to lobby', 'rematch', 'pink')}
    ${btn('View table', 'closeModal', 'white')}${btn('Leave', 'leave', 'white')}</div>${rows}`);
  // Confetti is saved for this moment only: a big burst as the winner is announced, plus one
  // from each winner's seat on the table behind.
  if (!reopen) {
    confetti(innerWidth / 2, innerHeight / 3, 160);
    for (const id of r.winners) { const st = seats[id]; if (st) { const [x, y] = center(st.el); confetti(x, y, 80); } }
    if (r.winners.includes(V.you)) sfx.win();
  }
}

// ---------------- modal / rules ----------------
function openModal(kind, html) {
  const m = $('#modal');
  m.dataset.kind = kind;
  m.innerHTML = `<div class="modal-bg" data-do="bgClose"><div class="panel modal">${html}<button class="iconbtn x" data-do="closeModal">✕</button></div></div>`;
}
function closeModal(kind) { const m = $('#modal'); if (!kind || m.dataset.kind === kind) { m.innerHTML = ''; m.dataset.kind = ''; } }
const RULES = `<div class="rules"><h2>How to play CABO</h2><button class="btn small pink" data-do="demo">Watch the demo</button>
<p><b>Goal:</b> finish with the <b>lowest</b> total. You get 4 face-down cards in a 2×2 grid and peek at the bottom two once. Then it's all memory.</p>
<h3>Your turn</h3><p>Draw a card. <b>A–6:</b> only you see it, and you must swap it into your grid (the old card is discarded). <b>7–K:</b> it goes face-up on the pile straight away so everyone can match it, then you use its power.</p>
<table><tr><td>A–6</td><td>Must swap. Ace is worth <b>−1</b>!</td></tr><tr><td>7, 8</td><td>Peek at one of your own cards</td></tr>
<tr><td>9, 10</td><td>Spy on an opponent's card</td></tr><tr><td>J</td><td>Blind-swap one of yours with any card</td></tr>
<tr><td>Q</td><td>Spy on an opponent's card, then optionally swap it with one of yours</td></tr><tr><td>K</td><td>Blind-swap two opponents' cards</td></tr></table>
<h3>Matching</h3><p>Tap any card — yours or an opponent's — that matches the <b>rank</b> of the top discard.
It stays matchable until the next card lands on the pile, while play goes on (just not while you're holding a drawn card or using a power).
Match your own card and it's gone. Match an opponent's card and you hand them one of yours into the same spot.
Wrong card = a hidden <b>penalty card</b>.</p>
<ul><li><b>Fastest Finger:</b> only the first match counts. Losing the race = penalty.</li><li><b>Multiple Discard:</b> keep matching until the next card lands.</li></ul>
<h3>CABO</h3><p>At the start of your turn, call CABO instead of drawing. Your cards lock and everyone else gets one final turn.
If anyone ends with a lower total than you, you get <b>+10 points</b> (a tie for lowest is fine).
Run out of cards completely and CABO is called for you.</p>
<h3>Scoring</h3><p>Add up your cards (J=11, Q=12, K=13, A=−1), penalties included. Four of a kind with no penalty cards scores <b>−4</b>. Lowest wins; ties are ties.</p></div>`;

// ---------------- input ----------------
document.addEventListener('click', (e) => {
  unlockAudio();
  // on phones the rules panel overlays the table, so any tap outside closes it
  if (innerWidth <= 760 && $('#cheat').classList.contains('open') && !e.target.closest('#cheat')) {
    $('#cheat').classList.remove('open'); localStorage.setItem('cabo.cheat', '0');
  }
  const slot = e.target.closest('.slot');
  if (slot && slot.dataset.owner) return clickSlot(slot);
  const b = e.target.closest('[data-do]');
  if (!b || b.disabled) return;
  const d = b.dataset.do;
  if (d === 'bgClose' && e.target !== b) return;
  sfx.click();
  const nm = () => { const n = $('#nameIn').value.trim() || 'Player'; localStorage.setItem('cabo.name', n); return n; };
  switch (d) {
    case 'create': send({ type: 'create', name: nm() }); break;
    case 'goSolo': homeStep('solo'); break;
    case 'goJoin': homeStep('join'); $('#codeIn').focus(); break;
    case 'homeBack': homeStep('pick'); break;
    case 'soloSet': {
      const s = soloPrefs();
      const k = b.dataset.k, v = b.dataset.v;
      s[k] = k === 'players' ? +v : v;
      localStorage.setItem('cabo.solo', JSON.stringify(s));
      renderSolo();
      break;
    }
    case 'solo': send({ type: 'solo', name: nm(), ...soloPrefs() }); break;
    case 'again': closeModal(); send({ type: 'rematch' }); send({ type: 'start' }); break;
    case 'join': {
      const code = $('#codeIn').value.trim().toUpperCase();
      if (code.length !== 4) return toast('Enter the 4-letter room code', 'bad');
      send({ type: 'join', code, name: nm() });
      break;
    }
    case 'rules': case 'rulesText': openModal('rules', RULES); break;
    case 'demo': openDemo(); break;
    case 'demoReplay': playDemo(); break;
    case 'demoPause': demoCtl.pause(b); break;
    case 'demoNext': demoCtl.next(); break;
    case 'demoPrev': demoCtl.prev(); break;
    case 'closeModal': case 'bgClose': closeModal(); break;
    case 'results': local.resultsShown = true; closeTour(); showResults(); break;
    case 'standings': local.resultsShown = true; showTour(true); break;
    case 'closeTour': closeTour(); break;
    case 'board': localStorage.setItem('cabo.board', $('#board').classList.contains('open') ? '0' : '1'); renderBoard(); fitTable(); break;
    case 'mute': muted = !muted; localStorage.setItem('cabo.muted', muted ? '1' : '0'); $('#muteBtn').classList.toggle('off', muted); break;
    case 'copy': navigator.clipboard?.writeText(b.dataset.link).then(() => toast('Invite link copied', 'good'), () => toast(b.dataset.link)); break;
    case 'addBot': send({ type: 'addBot' }); break;
    case 'kick': send({ type: 'kick', id: b.dataset.id }); break;
    case 'mode': send({ type: 'setMode', mode: b.dataset.mode }); break;
    case 'level': send({ type: 'setLevel', level: b.dataset.level }); break;
    case 'tourToggle': send({ type: 'setTour', on: !V.tourOn, rounds: V.tourRounds }); break;
    case 'tourRounds': send({ type: 'setTour', on: true, rounds: +b.dataset.n }); break;
    case 'ready': send({ type: 'ready', ready: !player(V.you).ready }); break;
    case 'start': send({ type: 'start' }); break;
    case 'rematch': closeModal(); send({ type: 'rematch' }); break;
    case 'leave':
      if (V && V.status !== 'LOBBY' && V.status !== 'GAME_OVER') {
        askConfirm({ title: 'Leave the game?', text: 'A bot takes over your cards, and you can\'t come back to this game.', yes: 'Leave', no: 'Stay' }, leaveRoom);
      } else leaveRoom();
      break;
    case 'confirmYes': answerConfirm(true); break;
    case 'confirmNo': answerConfirm(false); break;
    // game
    case 'view': act('view'); break;
    case 'viewReady': act('ready'); break;
    case 'draw':
      // the others still have a moment to match: remember the tap and draw the instant it opens
      if (drawLocked()) { local.wantDraw = true; renderGame(); drawWhenOpen(); } else act('draw');
      break;
    case 'cheat': { const open = !$('#cheat').classList.contains('open'); localStorage.setItem('cabo.cheat', open ? '1' : '0'); localStorage.setItem('cabo.cheatSeen', '1'); $('#cheat').classList.remove('nudge', 'poke'); $('#cheat').classList.toggle('open', open); $('#game').classList.toggle('cheat-open', open); break; }
    case 'cancel': act('cancel'); break;
    case 'swap': if (local.sel) act('swap', local.sel); break;
    case 'unsel': local.sel = null; renderGame(); break;
    case 'queenSwap': local.queenSwap = true; renderGame(); break;
    case 'queenBack': local.queenSwap = false; renderGame(); break;
    case 'queenKeep': act('queen', { swap: false }); break;
  }
});
function leaveRoom() { send({ type: 'leave' }); save(null); V = null; closeModal(); setUrl(location.pathname); show(); }

// Our own animated yes/no popup (instead of the browser's plain "localhost says" box).
// The safe choice is the big, focused button, so Enter or Esc never throws you out by accident.
let confirmCb = null;
function askConfirm({ title, text, yes, no }, onYes) {
  confirmCb = onYes;
  let box = $('#confirm');
  if (!box) { box = document.createElement('div'); box.id = 'confirm'; document.body.appendChild(box); }
  box.innerHTML = `<div class="cf-bg" data-do="confirmNo"></div>
    <div class="cf-panel" role="alertdialog" aria-modal="true" aria-labelledby="cfTitle">
      <div class="cf-cards"><div class="cf-card a"></div><div class="cf-card b"></div><div class="cf-card c"></div></div>
      <h2 id="cfTitle">${esc(title)}</h2><p>${esc(text)}</p>
      <div class="cf-btns">${btn(esc(no), 'confirmNo', 'lime big')}${btn(esc(yes), 'confirmYes', 'white big danger')}</div>
    </div>`;
  box.className = 'open';
  sfx.nope();
  setTimeout(() => { const b = box.querySelector('[data-do=confirmNo].btn'); b && b.focus(); }, 50);
}
function answerConfirm(yes) {
  const box = $('#confirm');
  if (!box || box.className !== 'open') return;
  const cb = confirmCb;
  confirmCb = null;
  box.className = 'closing';
  setTimeout(() => { if (box.className === 'closing') { box.className = ''; box.innerHTML = ''; } }, 260);
  if (yes && cb) cb();
}

document.addEventListener('keydown', (e) => {
  if ($('#confirm.open')) { if (e.key === 'Escape') answerConfirm(false); return; }
  if (e.key === 'Enter' && document.activeElement === $('#codeIn')) $('[data-do=join]').click();
  else if (e.key === 'Enter' && document.activeElement === $('#nameIn')) $('[data-do=create]').click();
  if (e.key === 'Escape') closeModal();
  // How to play: the arrow keys step through the demo
  if ($('#modal').dataset.kind === 'demo' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const b = $(e.key === 'ArrowLeft' ? '[data-do=demoPrev]' : '[data-do=demoNext]');
    if (b && !b.disabled) { e.preventDefault(); b.click(); }
  }
});

function clickSlot(el) {
  if (!V || !V.players) return;
  const owner = el.dataset.owner;
  const idx = Number(el.dataset.idx);
  const p = player(owner);
  const s = p && p.slots[idx];
  // tapping the card you're peeking at closes it and the game moves on; in an open window, if it
  // matches the card on the pile, the tap matches it instead
  const pk = s && ownTurn() && V.turn && (V.status === 'RESOLVING' || (V.turn.step === 'queen' && !local.queenSwap)) && at(visiblePeeks(), owner, idx, s);
  const pkMatch = pk && V.status === 'RESOLVING' && livePile() && pk.card.rank === V.phase.ref;
  if (pk && !pkMatch) {
    pulse(el, 'tapped');
    act('seen');
    return;
  }
  const it = interaction();
  if (!it || !s || s.empty || !it.ok(owner, idx)) { pulse(el, 'nope'); return; }
  const tg = { owner, idx, ver: s.ver };
  pulse(el, 'tapped');
  switch (it.kind) {
    case 'match': {
      const key = `${V.phase.id}:${owner}:${idx}:${s.ver}`;
      if (local.clicked.has(key)) return;
      local.clicked.add(key);
      sfx.tap();
      act('match', { phaseId: V.phase.id, ...tg });
      break;
    }
    case 'give': act('give', tg); break;
    case 'swap': sfx.tap(); act('swap', tg); break;
    case 'target': act('target', tg); break;
    case 'queenSwap': act('queen', { swap: true, ...tg }); break;
  }
}

// Add a temporary class. Overlapping pulses of the same class extend it rather than cutting it short,
// so e.g. a pile stays hidden until the *last* card flying towards it has landed.
function pulse(el, c, ms) {
  if (!el) return;
  const dur = ms || (c === 'flash' ? 900 : 380);
  const until = Date.now() + dur;
  el._until = el._until || {};
  if ((el._until[c] || 0) >= until) return;
  el._until[c] = until;
  el.classList.add(c);
  el._keep = (el._keep || new Set()).add(c);
  setTimeout(() => {
    if (Date.now() + 5 < el._until[c]) return; // a later pulse took over
    el.classList.remove(c);
    el._keep.delete(c);
  }, dur);
}

// ---------------- effects ----------------
function slotEl(owner, idx) { const s = seats[owner]; return s && s.slots[idx]; }
function center(el) { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
function floatText(text, el, cls = '') {
  const [x, y] = el ? center(el) : [innerWidth / 2, innerHeight / 2];
  const f = document.createElement('div');
  f.className = 'float ' + cls;
  f.textContent = text;
  f.style.left = x + 'px'; f.style.top = y + 'px';
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 2000);
}
// A deck tap made while it was still shut draws the moment it opens (timed to the opening, not
// left to the animation loop, which browsers slow down in background tabs).
function drawWhenOpen() {
  clearTimeout(local.drawTimer);
  if (!local.wantDraw || !V || !ownTurn() || !V.turn || V.turn.step !== 'draw') { local.wantDraw = false; return; }
  if (!drawLocked()) { local.wantDraw = false; act('draw'); return; }
  local.drawTimer = setTimeout(drawWhenOpen, Math.max(20, V.phase.minUntil - snow() + 20));
}
// Your turn: a small tag pops up over your seat. It never covers the deck, so you can draw at once.
function turnPill() {
  const st = seats[V.you];
  if (!st || document.hidden) return;
  st.el.querySelectorAll('.turnpill').forEach((e) => e.remove());
  const d = document.createElement('div');
  d.className = 'turnpill';
  d.textContent = 'Your turn';
  st.el.appendChild(d);
  setTimeout(() => d.remove(), 1600);
}
function bigCall(text, cls = '') {
  const d = document.createElement('div');
  d.className = 'bigcall ' + cls;
  d.innerHTML = `<span>${esc(text)}</span>`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 1900);
}
function penaltyPop(ev) {
  const d = document.createElement('div');
  d.className = 'penpop';
  d.innerHTML = `<div class="pp"><div class="pt">PENALTY!</div>
    ${ev.shown
      ? `<div class="pc"><div class="face front">${faceHTML(ev.shown.card)}</div></div><div class="pm">That was ${an(ev.shown.card.rank)}${SUIT[ev.shown.card.suit]}, not ${an(ev.ref)}!</div>`
      : '<div class="pm">Too slow — someone matched first!</div>'}
    <div class="ps">+1 face-down penalty card added to your hand</div></div>`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 3000);
}
// A card that physically flies across the table along an arc. It can flip on the way
// (flip: 'up' = back to face, 'down' = face to back), lands with a little thunk,
// and the destination stays hidden ('landing') until it arrives so it reads as the card moving.
function flyCard(fromEl, toEl, card, { delay = 0, ms = 950, arc = -70, spin = 14, flip = null } = {}) {
  if (!fromEl || !toEl || document.hidden) return; // background tabs don't animate; skip rather than pile up
  delay += fxHold;
  const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
  if (!a.width || !b.width) return;
  const d = document.createElement('div');
  d.className = 'flyer';
  const showFace = card && (flip === 'down' || (!flip && card));
  d.innerHTML = `<div class="fl-in" style="transform: rotateY(${showFace ? 180 : 0}deg)"><div class="face back"></div>${card ? `<div class="face front">${faceHTML(card)}</div>` : ''}</div>`;
  Object.assign(d.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px' });
  d.style.setProperty('--w', a.width + 'px');
  document.body.appendChild(d);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2), s = b.width / a.width;
  pulse(toEl, 'landing', delay + ms);
  const opts = { duration: ms, delay, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'both' };
  d.animate([
    { transform: 'translate(0,0) scale(1) rotate(0)' },
    { transform: `translate(${dx * 0.15}px, ${dy * 0.15 + arc * 0.6}px) scale(1.18) rotate(${-spin / 2}deg)`, offset: 0.2 },
    { transform: `translate(${dx / 2}px, ${dy / 2 + arc}px) scale(${((1 + s) / 2) * 1.3}) rotate(${spin}deg)`, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(0)` },
  ], opts).onfinish = () => {
    d.remove();
    pulse(toEl, 'thunk', 420);
  };
  if (flip && card) {
    d.firstChild.animate([{ transform: `rotateY(${flip === 'up' ? 0 : 180}deg)` }, { transform: `rotateY(${flip === 'up' ? 180 : 0}deg)` }],
      { ...opts, easing: 'cubic-bezier(.6,0,.3,1)' });
  }
  setTimeout(() => d.remove(), delay + ms + 500); // safety net if the animation never finishes
}

// ---------------- sticky hand grabber ----------------
// A stretchy red sticky-hand toy that shoots from a player's avatar on a wobbly arm, slaps a card,
// and either carries it somewhere (`via`: the discard pile, or another player's spot), recoils empty
// (miss), or just taps it (spy). A carried card shows its face only when `card` is given.
const HAND_SVG = `
  <g class="h-out"><path d="M2 0 H16"/><path d="M17 -2 L38 -17 M19 -1 L44 -6 M19 1 L44 6 M17 2 L37 17 M12 -5 L19 -20"/><circle cx="18" cy="0" r="12"/></g>
  <g class="h-in"><path d="M2 0 H16"/><path d="M17 -2 L38 -17 M19 -1 L44 -6 M19 1 L44 6 M17 2 L37 17 M12 -5 L19 -20"/><circle cx="18" cy="0" r="10"/>
    <circle cx="38" cy="-17" r="4.5"/><circle cx="44" cy="-6" r="4.5"/><circle cx="44" cy="6" r="4.5"/><circle cx="37" cy="17" r="4.5"/><circle cx="19" cy="-20" r="4"/></g>
  <g class="h-gloss"><path d="M14 -6 Q18 -9 23 -7"/><path d="M27 -9 L36 -15"/></g>`;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

function stickyHand(fromEl, toEl, { via = null, card = null, miss = false, color = null } = {}) {
  if (!fromEl || !toEl || document.hidden) return;
  const [ox, oy] = center(fromEl), [tx, ty] = center(toEl);
  const [vx, vy] = via ? center(via) : [tx, ty];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'grabber');
  // the hand takes the colour of the player it comes from
  const owner = color || (Object.keys(seats).find((id) => seats[id].el.contains(fromEl)) && colorOf(Object.keys(seats).find((id) => seats[id].el.contains(fromEl))));
  if (owner) svg.style.setProperty('--hand', owner);
  svg.innerHTML = `<path class="arm-out"/><path class="arm"/><path class="arm-gloss"/><g class="hand">${HAND_SVG}</g>`;
  document.body.appendChild(svg);
  const [armOut, arm, gloss] = svg.querySelectorAll('path');
  const hand = svg.querySelector('.hand');
  const tb = toEl.getBoundingClientRect();
  let carried = null;
  if (via) {
    carried = document.createElement('div');
    carried.className = 'carried';
    carried.style.width = tb.width + 'px'; carried.style.height = tb.height + 'px';
    carried.style.setProperty('--w', tb.width + 'px');
    carried.innerHTML = card ? `<div class="face front">${faceHTML(card)}</div>` : '<div class="face back"></div>';
  }
  const T_OUT = 360, T_GRIP = miss ? 260 : 170, T_DRAG = via ? 520 : 0, T_BACK = 430;
  const total = T_OUT + T_GRIP + T_DRAG + T_BACK;
  if (via) pulse(via, 'landing', T_OUT + T_GRIP + T_DRAG); // destination stays empty until the hand drops the card
  const start = performance.now();
  let grabbed = false, dropped = false;
  const cleanup = () => { svg.remove(); carried && carried.remove(); };

  const draw = (t) => {
    let px, py, sq = 1, wob;
    // the grab happens on the first frame at/after contact, even if a slow frame skipped the grip moment
    if (t >= T_OUT && !grabbed) {
      grabbed = true;
      pulse(toEl, 'grabbed', 500);
      if (carried) { document.body.appendChild(carried); pulse(toEl, 'landing', T_GRIP + T_DRAG); } // picked up: the spot looks empty
    }
    if (t < T_OUT) {
      const p = easeOutBack(t / T_OUT);
      px = ox + (tx - ox) * p; py = oy + (ty - oy) * p; wob = 1 - t / T_OUT;
    } else if (t < T_OUT + T_GRIP) {
      const p = (t - T_OUT) / T_GRIP;
      px = tx; py = ty; wob = 0.15; sq = 1 + 0.22 * Math.sin(p * Math.PI) * (miss ? 1.6 : 1);
    } else if (t < T_OUT + T_GRIP + T_DRAG) {
      const p = ease((t - T_OUT - T_GRIP) / T_DRAG);
      px = tx + (vx - tx) * p; py = ty + (vy - ty) * p; wob = 0.5 * Math.sin(p * Math.PI);
    } else {
      if (carried && !dropped) { dropped = true; carried.remove(); pulse(via, 'thunk', 420); }
      const p = ease((t - T_OUT - T_GRIP - T_DRAG) / T_BACK);
      const sx = via ? vx : tx, sy = via ? vy : ty;
      px = sx + (ox - sx) * p; py = sy + (oy - sy) * p; wob = 1 - p;
    }
    // slinky arm: a curve whose bend wiggles back and forth while it stretches
    const dx = px - ox, dy = py - oy, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const amp = Math.min(70, len * 0.28) * wob * Math.sin(t / 45);
    const cx = ox + dx / 2 + nx * amp, cy = oy + dy / 2 + ny * amp;
    const path = `M${ox},${oy} Q${cx},${cy} ${px},${py}`;
    armOut.setAttribute('d', path); arm.setAttribute('d', path); gloss.setAttribute('d', path);
    const ang = (Math.atan2(py - cy, px - cx) * 180) / Math.PI;
    const grow = Math.min(1, 0.55 + len / 160);
    hand.setAttribute('transform', `translate(${px},${py}) rotate(${ang}) translate(-30,0) scale(${grow * sq},${grow / sq})`);
    if (carried && grabbed && !dropped) {
      carried.style.left = px - tb.width / 2 + 'px';
      carried.style.top = py - tb.height / 2 + 'px';
      carried.style.transform = `rotate(${ang / 6}deg)`;
    }
  };
  const step = (now) => {
    const t = now - start;
    if (t >= total) return cleanup();
    draw(t);
    requestAnimationFrame(step);
  };
  draw(0);
  requestAnimationFrame(step);
  setTimeout(cleanup, total + 600); // safety net
  return draw; // exposed for testing single frames
}
// Where a player's sticky hand comes from: their avatar, or the whole seat when the avatar is hidden (phones).
const avatarEl = (pid) => {
  const s = seats[pid];
  if (!s) return null;
  const av = s.head.querySelector('.avatar');
  return av && av.getBoundingClientRect().width ? av : s.el;
};

// Dashed glowing link between two swapped cards, with a ⇄ badge in the middle.
function swapLink(elA, elB, ms = 2600) {
  if (!elA || !elB) return;
  const [x1, y1] = center(elA), [x2, y2] = center(elB);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 60;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'swaplink');
  svg.innerHTML = `<path d="M${x1},${y1} Q${mx},${my} ${x2},${y2}" /><circle cx="${x1}" cy="${y1}" r="7"/><circle cx="${x2}" cy="${y2}" r="7"/>`;
  document.body.appendChild(svg);
  const tag = document.createElement('div');
  tag.className = 'swaptag';
  tag.textContent = '⇄';
  tag.style.left = mx + 'px'; tag.style.top = (my + 30) + 'px';
  document.body.appendChild(tag);
  setTimeout(() => { svg.remove(); tag.remove(); }, ms);
}

// Full-screen CABO moment: burst rays, the word slams in, and who called it.
function caboCall(ev) {
  const who = ev.pid === V.you ? 'You' : nameOf(ev.pid);
  const d = document.createElement('div');
  d.className = 'cabocall';
  d.innerHTML = `<div class="rays"></div><div class="cc-inner"><div class="cc-word">CABO!</div>
    <div class="cc-who">${avatar(who, colorOf(ev.pid))}<span>${esc(who)} ${ev.auto ? 'ran out of cards!' : 'called it!'}</span></div>
    <div class="cc-sub">everyone else: 1 last turn</div></div>`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 3200);
}
// A stamp that slams onto the middle of the table and fades: marks the start of a phase.
function splash(text, cls) {
  const host = $('.table3 .center');
  if (!host || document.hidden) return;
  host.querySelectorAll('.splash').forEach((e) => e.remove());
  const d = document.createElement('div');
  d.className = 'splash ' + cls;
  d.textContent = text;
  host.appendChild(d);
  setTimeout(() => d.remove(), 1300);
}
// Opening deal: one card at a time from the draw pile, round the table starting on your left,
// four times over. Each spot stays empty until its card lands.
function dealFx() {
  const deck = $('#drawPile');
  const n = V.players.length, me = V.players.findIndex((p) => p.id === V.you);
  let k = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 1; j <= n; j++) {
      const p = V.players[(me + j) % n];
      const delay = 250 + k++ * 95;
      flyCard(deck, slotEl(p.id, i), null, { delay, ms: 460, arc: -36, spin: (Math.random() - 0.5) * 30 });
      setTimeout(() => sfx.deal(), delay);
    }
  }
  // the Peek button waits until every card is on the table
  const ms = 250 + k * 95 + 460;
  local.dealUntil = Date.now() + ms;
  setTimeout(() => V && V.status === 'INITIAL_VIEWING' && renderGame(), ms + 20);
}

// The draw pile ran out: the discards (all but the top card) slide over, get riffled together and
// squared up into a fresh draw pile. Later flights in the same update wait until it's done.
function reshuffleFx() {
  const from = $('#discardPile'), to = $('#drawPile');
  if (!from || !to || document.hidden) return;
  for (let i = 0; i < 7; i++) {
    flyCard(from, to, null, { delay: i * 70, ms: 420, arc: -30 - i * 4, spin: i % 2 ? 9 : -9 });
    if (i % 2 === 0) setTimeout(() => sfx.whoosh(), i * 70);
  }
  setTimeout(() => { pulse(to, 'shuffling', 900); [0, 90, 180, 270].forEach((t) => setTimeout(() => sfx.tap(), t + 120)); }, 6 * 70 + 420);
  fxHold = 6 * 70 + 420 + 800;
}

// An eye that peeps out from behind a card, looks left and right, blinks, and ducks back. Top-row
// cards have the name tag above them, so there it peeps out from under the card instead.
function peekEye(el, color, below = false) {
  if (!el || document.hidden) return;
  const r = el.getBoundingClientRect();
  const w = Math.max(34, r.width * 0.7);
  const d = document.createElement('div');
  d.className = 'peekeye' + (below ? ' below' : '');
  Object.assign(d.style, { left: r.left + r.width / 2 + 'px', top: (below ? r.bottom : r.top) + 'px', width: w + 'px' });
  if (color) d.style.setProperty('--iris', color);
  d.innerHTML = `<svg viewBox="-30 -21 60 40"><g class="lid">
      <path class="white" d="M-26 0 Q0 -22 26 0 Q0 22 -26 0Z"/>
      <g class="look"><circle class="iris" r="9"/><circle class="pupil" r="4.2"/><circle class="glint" cx="3" cy="-3.2" r="1.8"/></g>
      <path class="rim" d="M-26 0 Q0 -22 26 0 Q0 22 -26 0Z"/></g>
      <path class="lash" d="M-14 -11 L-17 -16 M0 -14 L0 -19 M14 -11 L17 -16"/></svg>`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 1900);
}
function shake() { const a = $('#app'); a.classList.remove('shake'); void a.offsetWidth; a.classList.add('shake'); }

// One clear signal per event: the animation itself carries most of the meaning, and words are added
// only when they say something you can't already see (e.g. someone took one of *your* cards).
function runFx(ev) {
  const mine = ev.pid === V.you;
  switch (ev.kind) {
    case 'turn':
      if (mine) { sfx.turn(); turnPill(); }
      break;
    case 'draw':
      sfx.draw();
      flyCard($('#drawPile'), $('#handzone .handcard'), mine ? V.hand : null, { ms: 750, arc: -60, spin: -12, flip: mine && V.hand ? 'up' : null });
      break;
    case 'swap': {
      // the replaced card flies face-up onto the pile, then the drawn card slides into its place
      sfx.whoosh();
      const el = slotEl(ev.a.owner, ev.a.idx);
      flyCard(el, $('#discardPile'), V.discardTop, { ms: 900, arc: -90, spin: 20, flip: 'up' });
      const drawn = mine && local.lastHand;
      flyCard($('#handzone .handcard'), el, drawn || null, { delay: 450, ms: 750, arc: 30, spin: -8, flip: drawn ? 'down' : null });
      if (el) setTimeout(() => pulse(el, 'swapped', 1400), 1250);
      break;
    }
    case 'discard': sfx.whoosh(); flyCard($('#handzone .handcard'), $('#discardPile'), V.discardTop, { ms: 800, arc: -40 }); break;
    case 'reveal':
      // 7–K go straight onto the pile face-up: the card landing there is the whole message
      sfx.whoosh();
      flyCard($('#drawPile'), $('#discardPile'), ev.card, { ms: 800, arc: -80, spin: -16, flip: 'up' });
      break;
    case 'power':
      // the purple mood and the caption ("J · Swap one of yours…") explain it; this marks the moment
      splash('POWER', 'power');
      if (mine) sfx.turn();
      break;
    case 'swapfx': {
      // Jack / King / Queen swaps: the two cards visibly cross the table into each other's places
      sfx.whoosh();
      setTimeout(() => sfx.whoosh(), 180);
      const ea = slotEl(ev.a.owner, ev.a.idx), eb = slotEl(ev.b.owner, ev.b.idx);
      if (ev.a.owner !== ev.b.owner) {
        // between two players: two sticky hands from the swapper each carry one card across
        stickyHand(avatarEl(ev.pid), ea, { via: eb });
        setTimeout(() => stickyHand(avatarEl(ev.pid), eb, { via: ea }), 140);
      } else {
        swapLink(ea, eb);
        flyCard(ea, eb, null, { delay: 250, ms: 1200, arc: -90, spin: 18 });
        flyCard(eb, ea, null, { delay: 250, ms: 1200, arc: 90, spin: -18 });
      }
      for (const el of [ea, eb]) if (el) pulse(el, 'swapped', 3000);
      // say it in words only when one of *your* cards moved — that's easy to miss and matters
      if (!mine && (ev.a.owner === V.you || ev.b.owner === V.you)) toast(`${nameOf(ev.pid)} swapped one of your cards`, 'bad');
      break;
    }
    case 'peek': {
      // looking at your own card (7/8): a little eye peeps over its top edge, glances, blinks and ducks
      // away. Someone else's card: the looker's sticky hand taps it.
      const el = slotEl(ev.a.owner, ev.a.idx);
      // the card being looked at lifts and tilts up, as if picked up, glowing in the looker's colour
      if (el) el.style.setProperty('--lift', colorOf(ev.pid));
      if (ev.a.owner !== ev.pid) {
        // 9 / 10 / Queen: the looker's sticky hand reaches over and lifts the card as it lands on it
        stickyHand(avatarEl(ev.pid), el);
        if (el) setTimeout(() => pulse(el, 'lifted', 1700), 340);
      } else if (el) {
        pulse(el, 'lifted', 1900);
        peekEye(el, colorOf(ev.pid), ev.a.idx < 2);
      }
      sfx.peek();
      break;
    }
    case 'match': {
      const el = slotEl(ev.owner, ev.idx);
      if (ev.owner !== ev.pid) stickyHand(avatarEl(ev.pid), el, { via: $('#discardPile'), card: ev.card });
      else flyCard(el, $('#discardPile'), ev.card, { ms: 800, arc: -60, flip: 'up' });
      floatText(mine ? 'MATCH!' : `${nameOf(ev.pid)} matched!`, el, 'good');
      sfx.match();
      if (!mine && ev.owner === V.you) toast(`${nameOf(ev.pid)} took one of your cards`, 'bad');
      break;
    }
    case 'give': {
      const el = slotEl(ev.to.owner, ev.to.idx);
      stickyHand(avatarEl(ev.pid), slotEl(ev.from.owner, ev.from.idx), { via: el });
      if (el) setTimeout(() => pulse(el, 'swapped', 1400), 1100);
      break;
    }
    case 'penalty': {
      if (ev.shown && ev.shown.owner !== ev.pid) stickyHand(avatarEl(ev.pid), slotEl(ev.shown.owner, ev.shown.idx), { miss: true });
      if (mine) {
        // the popup explains what happened; no extra floating labels on top of it
        shake(); sfx.buzz();
        penaltyPop(ev);
      } else {
        sfx.boop();
        if (ev.shown) setTimeout(() => { const el = slotEl(ev.shown.owner, ev.shown.idx); el && floatText('WRONG', el, 'bad'); }, ev.shown.owner !== ev.pid ? 450 : 0);
      }
      setTimeout(() => flyCard($('#drawPile'), slotEl(ev.pid, ev.idx), null, { ms: 900, arc: -60 }), 30);
      break;
    }
    case 'cabo':
      sfx.cabo(); caboCall(ev); shake();
      break;
    case 'reshuffle': reshuffleFx(); break;
    case 'window': sfx.open(); if (!V.open) splash('MATCH!', 'match'); break; // open window: the pile just glows
    case 'gameover': sfx.reveal(); break;
  }
}

function toast(msg, cls = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + cls;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4500);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
}

// confetti
const cv = $('#fx');
const cx = cv.getContext('2d');
let parts = [];
function resize() { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; cx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); }
addEventListener('resize', resize); resize();
function confetti(x, y, n) {
  const cols = ['#ffd23f', '#ff4fa3', '#2ee6d6', '#9bf34a', '#ff8a3d', '#8b5cff'];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 8;
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 5, r: 4 + Math.random() * 5, c: cols[i % cols.length], rot: Math.random() * 6, vr: (Math.random() - .5) * .4, life: 70 + Math.random() * 40 });
  }
}

// ---------------- frame loop: timers & expiries ----------------
let lastSig = '', lastSec = null;
function frame() {
  requestAnimationFrame(frame);
  if (parts.length) {
    cx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => p.life-- > 0);
    for (const p of parts) {
      p.vy += .25; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot); cx.globalAlpha = Math.min(1, p.life / 30);
      cx.fillStyle = p.c; cx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); cx.restore();
    }
    if (!parts.length) cx.clearRect(0, 0, innerWidth, innerHeight);
  }
  if (!V || V.status === 'LOBBY') return;
  const now = snow();
  // re-render when a peek expires or the matching window closes locally
  const sig = visiblePeeks().length + ':' + visibleReveals().length + ':' + (V.phase && V.phase.open && now < V.phase.deadline ? 1 : 0) +
    ':' + drawLocked() + ':' + !!(V.phase && V.phase.lateUntil && now < V.phase.lateUntil);
  if (sig !== lastSig) { lastSig = sig; renderGame(); }
  if (local.wantDraw) drawWhenOpen();
  if (V.phase) {
    const rem = Math.max(0, V.phase.deadline - now);
    const secs = Math.ceil(rem / 1000);
    // countdown drains around the active player's seat border
    const total = 5000;
    for (const [pid, s] of Object.entries(seats)) {
      const on = pid === V.activeId && V.phase.open && rem > 0;
      s.el.classList.toggle('timing', on);
      if (on) {
        s.el.style.setProperty('--p', Math.min(1, rem / total).toFixed(3));
        s.el.style.setProperty('--tc', secs <= 1 ? 'var(--red)' : secs <= 2 ? 'var(--yellow)' : 'var(--lime)');
      }
    }
    if (secs !== lastSec) { if (lastSec !== null && secs > 0 && secs <= 3 && V.phase.open) sfx.tick(secs); lastSec = secs; }
  } else {
    lastSec = null;
    for (const s of Object.values(seats)) s.el.classList.remove('timing');
  }
}

// ---------------- sound (tiny WebAudio synth) ----------------
let AC = null;
function unlockAudio() { if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } else if (AC.state === 'suspended') AC.resume(); }
function tone(f, d = .12, type = 'square', vol = .08, slide = 0, delay = 0) {
  if (muted || !AC) return;
  const t = AC.currentTime + delay;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t + d);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + d);
  o.connect(g).connect(AC.destination); o.start(t); o.stop(t + d + .02);
}
const sfx = {
  click: () => tone(660, .05, 'triangle', .05),
  tap: () => tone(880, .06, 'triangle', .07, 300),
  deal: () => tone(1500 + Math.random() * 300, .035, 'triangle', .035, -500),
  nope: () => tone(180, .12, 'sawtooth', .04),
  draw: () => tone(400, .12, 'triangle', .06, 400),
  whoosh: () => tone(900, .18, 'sine', .06, -700),
  peek: () => { tone(700, .08, 'sine', .06); tone(1050, .1, 'sine', .06, 0, .08); },
  open: () => tone(520, .1, 'square', .04, 200),
  tick: (s) => tone(s === 1 ? 1200 : 900, .07, 'square', .05),
  match: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, .14, 'square', .06, 0, i * .07)),
  buzz: () => { tone(150, .3, 'sawtooth', .08, -60); tone(110, .3, 'square', .05, -40, .05); },
  boop: () => tone(240, .15, 'triangle', .05, -80),
  turn: () => [660, 880].forEach((f, i) => tone(f, .15, 'triangle', .08, 0, i * .1)),
  cabo: () => [392, 392, 523, 659].forEach((f, i) => tone(f, i === 3 ? .4 : .13, 'square', .08, 0, i * .12)),
  reveal: () => [300, 400, 500, 600, 800].forEach((f, i) => tone(f, .1, 'triangle', .06, 0, i * .06)),
  win: () => [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, .18, 'square', .07, 0, i * .12)),
  // tournament: a drumroll before the champion, a thump as someone lands on the podium
  drum: () => { for (let i = 0; i < 16; i++) tone(i % 2 ? 98 : 110, .06, 'triangle', .05 + i * .003, 0, i * .075); },
  land: () => tone(160, .14, 'sine', .08, -60),
  rise: () => tone(300, .35, 'triangle', .04, 500),
};

// Some browsers refuse URL changes on local files; the room code in the URL is only a convenience.
function setUrl(u) { try { history.replaceState(null, '', u); } catch {} }

if (window.CABO_OFFLINE) {
  // offline single-file build: no joining or invite links, just you vs bots
  document.body.classList.add('offline');
  local.homeStep = 'solo';
  save(null);
}
homeStory();
if (!session) show();
connect();
requestAnimationFrame(frame);
