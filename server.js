// Teen Patti Online: one big table for up to 60 players, 5-deck shoe, virtual chips, card exchange.
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');
const { buildShoe, shuffle, compare, describe } = require('./hands');

const PORT = process.env.PORT || 3000;
const DECKS = 5;

const app = express();
for (const f of ['index.html', 'style.css', 'app.js']) app.get('/' + f, (_req, res) => res.sendFile(path.join(__dirname, f)));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

// ---------------------------------------------------------------- state
const settings = {
  maxPlayers: 60,
  startChips: 1000,
  boot: 10,
  stakeCapMult: 128,      // blind stake can never exceed boot x this
  turnSeconds: 30,
  exchangesPerRound: 1,   // per player, any exchange type counts
  exchangeFeeMult: 1,     // fee = current stake x this (0 = free)
  autoNext: true,         // start next round automatically
};

const players = new Map(); // id -> player
const seatOrder = [];      // ids in join order
let hostId = null;
let log = [];
let roundNo = 0;

let round = null; // { pot, stake, order:[ids], turn:id, dealer, shoe, discard, deadline, result }
let lastResult = null;
let paused = false;      // host paused: no automatic next round
let lastDealer = null;
let turnTimer = null, nextTimer = null;
const swapRequests = new Map(); // requestId -> { id, from, to, fromIdx, expires }

const uid = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

function addLog(text) {
  log.push({ t: now(), text });
  if (log.length > 80) log = log.slice(-80);
}

function cardStr(c) {
  const r = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[c.r] || c.r;
  return r + { S: '♠', H: '♥', D: '♦', C: '♣' }[c.s];
}

// ---------------------------------------------------------------- helpers
function inHand(p) { return round && p && round.order.includes(p.id) && !p.packed; }
function activeIds() { return round ? round.order.filter(id => !players.get(id).packed) : []; }

function draw() {
  if (round.shoe.length === 0) {
    if (round.discard.length === 0) return null;
    round.shoe = shuffle(round.discard);
    round.discard = [];
    addLog('Shoe ran out: discards reshuffled into the shoe.');
  }
  return round.shoe.pop();
}

function take(p, amount) {
  const a = Math.min(amount, p.chips);
  p.chips -= a;
  round.pot += a;
  return a;
}

function pickHost() {
  if (hostId && players.has(hostId)) return;
  const next = seatOrder.map(id => players.get(id)).find(p => p && p.connected) || players.get(seatOrder[0]);
  hostId = next ? next.id : null;
  if (next) addLog(`${next.name} is now the host.`);
}

// ---------------------------------------------------------------- round flow
function startRound() {
  clearTimeout(nextTimer);
  if (round) return 'A round is already running.';
  const eligible = seatOrder.map(id => players.get(id)).filter(p => p.chips >= settings.boot && !p.sittingOut);
  if (eligible.length < 2) return 'Need at least 2 players with enough chips for the boot.';
  roundNo++;
  // rotate dealer
  const prevDealer = lastDealer;
  let dIdx = prevDealer ? eligible.findIndex(p => seatOrder.indexOf(p.id) > seatOrder.indexOf(prevDealer)) : 0;
  if (dIdx < 0) dIdx = 0;
  const dealer = eligible[dIdx].id;
  // play order starts left of dealer
  const order = [...eligible.slice(dIdx + 1), ...eligible.slice(0, dIdx + 1)].map(p => p.id);

  round = { no: roundNo, pot: 0, stake: settings.boot, order, turn: null, dealer, shoe: buildShoe(DECKS), discard: [], deadline: 0 };
  swapRequests.clear();
  for (const p of players.values()) {
    p.hand = []; p.seen = false; p.packed = !order.includes(p.id); p.exchanges = 0; p.lastAction = '';
  }
  for (let i = 0; i < 3; i++) for (const id of order) players.get(id).hand.push(draw());
  for (const id of order) take(players.get(id), settings.boot);
  lastResult = null;
  addLog(`Round ${roundNo} started with ${order.length} players. Boot ${settings.boot}, pot ${round.pot}. Shoe: ${DECKS} decks.`);
  setTurn(order[0]);
  return null;
}

function setTurn(id) {
  round.turn = id;
  round.deadline = now() + settings.turnSeconds * 1000;
  clearTimeout(turnTimer);
  turnTimer = setTimeout(() => {
    const p = players.get(id);
    if (round && round.turn === id && p) {
      addLog(`${p.name} ran out of time and packed.`);
      doPack(p);
      broadcast();
    }
  }, settings.turnSeconds * 1000 + 300);
}

function advanceTurn() {
  if (checkEnd()) return;
  const order = round.order;
  let i = order.indexOf(round.turn);
  for (let k = 0; k < order.length; k++) {
    i = (i + 1) % order.length;
    if (!players.get(order[i]).packed) return setTurn(order[i]);
  }
}

function checkEnd() {
  const act = activeIds();
  if (act.length === 1) {
    const w = players.get(act[0]);
    finishRound([w.id], `${w.name} wins ${round.pot} chips (everyone else packed).`, []);
    return true;
  }
  return false;
}

function finishRound(winnerIds, text, reveal) {
  clearTimeout(turnTimer);
  const share = winnerIds.length ? Math.floor(round.pot / winnerIds.length) : 0;
  lastDealer = round.dealer;
  winnerIds.forEach(id => { players.get(id).chips += share; });
  addLog(text);
  lastResult = { no: round.no, winners: winnerIds, text, reveal, dealer: round.dealer, pot: round.pot };
  round = null;
  swapRequests.clear();
  scheduleNext();
}

function scheduleNext() {
  clearTimeout(nextTimer);
  if (settings.autoNext && !paused) {
    nextTimer = setTimeout(() => { if (!round && !paused) { const err = startRound(); if (!err) broadcast(); } }, 8000);
  }
}

function doPack(p) {
  if (!inHand(p)) return;
  p.packed = true; p.lastAction = 'Packed';
  // cancel swap requests involving this player
  for (const [rid, r] of swapRequests) if (r.from === p.id || r.to === p.id) swapRequests.delete(rid);
  if (round.turn === p.id) advanceTurn();
  else checkEnd();
}

// ---------------------------------------------------------------- actions
function stakeCap() { return settings.boot * settings.stakeCapMult; }

function handleAction(p, a) {
  if (!round) return 'No round in progress.';
  if (!inHand(p)) return 'You are not in this hand.';
  const myTurn = round.turn === p.id;

  switch (a.type) {
    case 'see':
      if (p.seen) return null;
      p.seen = true; p.lastAction = 'Seen';
      addLog(`${p.name} looked at their cards.`);
      return null;

    case 'pack':
      addLog(`${p.name} packed.`);
      doPack(p);
      return null;

    case 'chaal': {
      if (!myTurn) return 'Not your turn.';
      const raise = !!a.raise;
      if (raise && round.stake * 2 > stakeCap()) return 'Stake limit reached, you cannot raise.';
      if (raise) round.stake *= 2;
      const amount = p.seen ? round.stake * 2 : round.stake;
      if (p.chips < amount) return `You need ${amount} chips. Pack or go all-in via Show if 2 players remain.`;
      take(p, amount);
      p.lastAction = `${p.seen ? 'Chaal' : 'Blind'} ${amount}${raise ? ' (raise)' : ''}`;
      addLog(`${p.name}: ${p.lastAction}. Pot ${round.pot}.`);
      advanceTurn();
      return null;
    }

    case 'show': {
      if (!myTurn) return 'Not your turn.';
      const act = activeIds();
      if (act.length !== 2) return 'Show is only allowed when 2 players remain.';
      const other = players.get(act.find(id => id !== p.id));
      const amount = p.seen ? round.stake * 2 : round.stake;
      take(p, amount);
      const c = compare(p.hand, other.hand);
      const winner = c > 0 ? p : other; // on an exact tie, the player who asked for the show loses
      const reveal = [p, other].map(x => ({ id: x.id, name: x.name, hand: x.hand, label: describe(x.hand) }));
      const tieNote = c === 0 ? ' (identical hands: the player who asked for the show loses)' : '';
      finishRound([winner.id], `Show! ${p.name} [${p.hand.map(cardStr).join(' ')} ${describe(p.hand)}] vs ${other.name} [${other.hand.map(cardStr).join(' ')} ${describe(other.hand)}]. ${winner.name} wins ${round.pot} chips${tieNote}.`, reveal);
      return null;
    }

    case 'exchange-one':
    case 'exchange-all': {
      if (!myTurn) return 'Exchanges with the shoe are done on your turn.';
      if (!p.seen) return 'See your cards before exchanging.';
      if (p.exchanges >= settings.exchangesPerRound) return 'No exchanges left this round.';
      const fee = round.stake * settings.exchangeFeeMult;
      if (p.chips < fee) return `Exchange fee is ${fee} chips.`;
      if (a.type === 'exchange-one') {
        const idx = Number(a.index);
        if (!(idx >= 0 && idx < 3)) return 'Pick a card to exchange.';
        const card = draw();
        if (!card) return 'Shoe is empty.';
        round.discard.push(p.hand[idx]);
        p.hand[idx] = card;
        p.lastAction = 'Exchanged 1 card';
      } else {
        if (round.shoe.length + round.discard.length < 3) return 'Not enough cards in the shoe.';
        const old = p.hand;
        p.hand = [draw(), draw(), draw()];
        round.discard.push(...old);
        p.lastAction = 'Exchanged full hand';
      }
      take(p, fee);
      p.exchanges++;
      addLog(`${p.name} ${p.lastAction.toLowerCase()} with the shoe${fee ? ` (fee ${fee})` : ''}.`);
      // exchange does not end the turn, but refreshes the timer a little
      round.deadline = Math.max(round.deadline, now() + 15000);
      setTurnTimerOnly();
      return null;
    }

    case 'swap-request': {
      if (!p.seen) return 'See your cards before offering a swap.';
      if (p.exchanges >= settings.exchangesPerRound) return 'No exchanges left this round.';
      const target = players.get(a.to);
      if (!target || target.id === p.id || !inHand(target)) return 'That player is not in this hand.';
      const idx = Number(a.index);
      if (!(idx >= 0 && idx < 3)) return 'Pick which of your cards to offer.';
      for (const r of swapRequests.values()) if (r.from === p.id) return 'You already have a pending swap request.';
      const fee = round.stake * settings.exchangeFeeMult;
      if (p.chips < fee) return `Exchange fee is ${fee} chips.`;
      const rid = uid();
      swapRequests.set(rid, { id: rid, from: p.id, to: target.id, fromIdx: idx, expires: now() + 20000, round: round.no });
      setTimeout(() => { if (swapRequests.delete(rid)) broadcast(); }, 20500);
      addLog(`${p.name} offered a card swap to ${target.name}.`);
      return null;
    }

    case 'swap-cancel': {
      for (const [rid, r] of swapRequests) if (r.from === p.id) swapRequests.delete(rid);
      return null;
    }

    case 'swap-reply': {
      const r = swapRequests.get(a.requestId);
      if (!r || r.to !== p.id) return 'That swap request has expired.';
      swapRequests.delete(r.id);
      const from = players.get(r.from);
      if (!a.accept) { addLog(`${p.name} declined ${from.name}'s swap.`); return null; }
      if (!inHand(from)) return 'The other player is no longer in the hand.';
      const idx = Number(a.index);
      if (!(idx >= 0 && idx < 3)) return 'Pick which of your cards to give.';
      const fee = round.stake * settings.exchangeFeeMult;
      if (from.exchanges >= settings.exchangesPerRound || from.chips < fee) return 'The other player can no longer swap.';
      const give = from.hand[r.fromIdx], get = p.hand[idx];
      from.hand[r.fromIdx] = get; p.hand[idx] = give;
      take(from, fee);
      from.exchanges++;
      p.seen = true;
      from.lastAction = `Swapped with ${p.name}`;
      p.lastAction = `Swapped with ${from.name}`;
      addLog(`${from.name} and ${p.name} swapped one card${fee ? ` (fee ${fee} paid by ${from.name})` : ''}.`);
      return null;
    }
  }
  return 'Unknown action.';
}

function setTurnTimerOnly() {
  const id = round.turn;
  clearTimeout(turnTimer);
  turnTimer = setTimeout(() => {
    const p = players.get(id);
    if (round && round.turn === id && p) { addLog(`${p.name} ran out of time and packed.`); doPack(p); broadcast(); }
  }, Math.max(0, round.deadline - now()) + 300);
}

// ---------------------------------------------------------------- views
function publicPlayer(p) {
  return {
    id: p.id, name: p.name, chips: p.chips, connected: p.connected, rebuys: p.rebuys,
    inRound: !!(round && round.order.includes(p.id)), packed: p.packed, seen: p.seen,
    lastAction: p.lastAction, exchanges: p.exchanges, sittingOut: !!p.sittingOut,
    net: p.chips - settings.startChips * (1 + p.rebuys),
  };
}

function viewFor(p) {
  return {
    me: p ? {
      id: p.id, name: p.name, chips: p.chips, seen: p.seen, packed: p.packed, rebuys: p.rebuys,
      hand: p.hand && p.hand.length && p.seen ? p.hand : null,
      handLabel: p.hand && p.hand.length && p.seen ? describe(p.hand) : null,
      exchangesLeft: Math.max(0, settings.exchangesPerRound - (p.exchanges || 0)),
      inRound: inHand(p), sittingOut: !!p.sittingOut,
    } : null,
    isHost: p && p.id === hostId,
    paused,
    hostId,
    settings,
    players: seatOrder.map(id => publicPlayer(players.get(id))),
    round: round ? {
      no: round.no, pot: round.pot, stake: round.stake, turn: round.turn, dealer: round.dealer,
      deadline: round.deadline, active: activeIds().length, shoe: round.shoe.length, discard: round.discard.length,
      stakeCap: stakeCap(),
    } : null,
    lastResult,
    swaps: [...swapRequests.values()].filter(r => p && (r.to === p.id || r.from === p.id)).map(r => ({
      id: r.id, from: r.from, to: r.to, expires: r.expires,
      fromName: players.get(r.from)?.name, toName: players.get(r.to)?.name,
      incoming: r.to === p.id,
    })),
    log: log.slice(-40),
    serverTime: now(),
  };
}

let broadcastQueued = false;
function broadcast() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setImmediate(() => {
    broadcastQueued = false;
    for (const s of io.sockets.sockets.values()) s.emit('state', viewFor(players.get(s.data.pid)));
  });
}

// ---------------------------------------------------------------- sockets
io.on('connection', socket => {
  socket.on('join', ({ name, token }, cb = () => {}) => {
    // reconnect with token
    if (token) {
      const existing = [...players.values()].find(p => p.token === token);
      if (existing) {
        existing.connected = true; existing.socketId = socket.id;
        socket.data.pid = existing.id;
        pickHost();
        cb({ ok: true, token: existing.token, id: existing.id });
        return broadcast();
      }
    }
    name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 18);
    if (!name) return cb({ ok: false, error: 'Please enter your name.' });
    if (players.size >= settings.maxPlayers) return cb({ ok: false, error: `Table is full (${settings.maxPlayers} players).` });
    if ([...players.values()].some(p => p.name.toLowerCase() === name.toLowerCase()))
      return cb({ ok: false, error: 'That name is taken, try another.' });
    const p = {
      id: uid(), token: uid() + uid(), name, chips: settings.startChips, rebuys: 0,
      connected: true, socketId: socket.id, hand: [], seen: false, packed: true, exchanges: 0, lastAction: '',
    };
    players.set(p.id, p); seatOrder.push(p.id);
    socket.data.pid = p.id;
    if (!hostId) { hostId = p.id; }
    addLog(`${name} joined the table.${round ? ' They will be dealt in next round.' : ''}`);
    cb({ ok: true, token: p.token, id: p.id });
    broadcast();
  });

  const me = () => players.get(socket.data.pid);

  socket.on('action', (a, cb = () => {}) => {
    const p = me(); if (!p || !a) return cb({ ok: false, error: 'Join first.' });
    const err = handleAction(p, a);
    cb(err ? { ok: false, error: err } : { ok: true });
    broadcast();
  });

  socket.on('rebuy', (cb = () => {}) => {
    const p = me(); if (!p) return;
    if (inHand(p)) return cb({ ok: false, error: 'Finish the hand first.' });
    if (p.chips >= settings.boot * 4) return cb({ ok: false, error: 'Rebuy is only for players almost out of chips.' });
    p.chips += settings.startChips; p.rebuys++;
    addLog(`${p.name} rebought ${settings.startChips} chips.`);
    cb({ ok: true }); broadcast();
  });

  socket.on('sitout', (val, cb = () => {}) => {
    const p = me(); if (!p) return;
    p.sittingOut = !!val; cb({ ok: true }); broadcast();
  });

  socket.on('leave', () => {
    const p = me(); if (!p) return;
    removePlayer(p, `${p.name} left the table.`);
    socket.data.pid = null;
    broadcast();
  });

  // ---- host controls
  socket.on('host', (cmd, cb = () => {}) => {
    const p = me();
    if (!p || p.id !== hostId) return cb({ ok: false, error: 'Only the host can do that.' });
    let err = null;
    switch (cmd.type) {
      case 'start': paused = false; err = startRound(); break;
      case 'pause':
        paused = true; clearTimeout(nextTimer);
        addLog(round ? 'Host paused the game: no new round will start after this one.' : 'Host paused the game.');
        break;
      case 'resume':
        paused = false;
        addLog('Host resumed the game.');
        if (!round) err = startRound();
        break;
      case 'end-round':
        paused = true; clearTimeout(nextTimer);
        if (round) {
          // split pot equally among active players
          const act = activeIds();
          finishRound(act, `Host ended round ${round.no}; pot split among ${act.length} active players.`, []);
        }
        break;
      case 'kick': {
        const t = players.get(cmd.id);
        if (t && t.id !== p.id) removePlayer(t, `${t.name} was removed by the host.`);
        break;
      }
      case 'make-host': if (players.has(cmd.id)) { hostId = cmd.id; addLog(`${players.get(cmd.id).name} is now the host.`); } break;
      case 'settings': {
        const s = cmd.settings || {};
        const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v))));
        if (s.boot != null) settings.boot = num(s.boot, 1, 100000);
        if (s.startChips != null) settings.startChips = num(s.startChips, 10, 10000000);
        if (s.turnSeconds != null) settings.turnSeconds = num(s.turnSeconds, 10, 180);
        if (s.exchangesPerRound != null) settings.exchangesPerRound = num(s.exchangesPerRound, 0, 5);
        if (s.exchangeFeeMult != null) settings.exchangeFeeMult = num(s.exchangeFeeMult, 0, 10);
        if (s.stakeCapMult != null) settings.stakeCapMult = num(s.stakeCapMult, 2, 4096);
        if (s.maxPlayers != null) settings.maxPlayers = num(s.maxPlayers, 2, 100);
        if (s.autoNext != null) { settings.autoNext = !!s.autoNext; if (!settings.autoNext) clearTimeout(nextTimer); else if (!round) scheduleNext(); }
        addLog('Host updated the table settings.');
        break;
      }
      case 'reset-chips':
        if (round) { err = 'End the round first.'; break; }
        for (const q of players.values()) { q.chips = settings.startChips; q.rebuys = 0; }
        addLog('Host reset everyone to the starting chips.');
        break;
      default: err = 'Unknown command.';
    }
    cb(err ? { ok: false, error: err } : { ok: true });
    broadcast();
  });

  socket.on('disconnect', () => {
    const p = me(); if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    if (p.id === hostId) {
      // hand host to someone connected after a grace period
      setTimeout(() => {
        if (!p.connected && hostId === p.id) {
          const next = seatOrder.map(id => players.get(id)).find(q => q && q.connected);
          if (next) { hostId = next.id; addLog(`${next.name} is now the host.`); broadcast(); }
        }
      }, 15000);
    }
    // players gone for 10 minutes are removed
    setTimeout(() => { if (!p.connected && players.has(p.id)) { removePlayer(p, `${p.name} was removed (disconnected).`); broadcast(); } }, 10 * 60 * 1000);
    broadcast();
  });
});

function removePlayer(p, msg) {
  if (inHand(p)) doPack(p);
  players.delete(p.id);
  const i = seatOrder.indexOf(p.id); if (i >= 0) seatOrder.splice(i, 1);
  if (round) {
    // keep order intact for turn rotation, but a removed player is treated as packed
    round.order = round.order.filter(id => players.has(id));
    if (round.order.length && !players.has(round.turn)) advanceTurn();
    if (round && activeIds().length <= 1) checkEnd();
  }
  addLog(msg);
  if (hostId === p.id) { hostId = null; pickHost(); }
}

server.listen(PORT, () => console.log(`Teen Patti running on http://localhost:${PORT}`));
