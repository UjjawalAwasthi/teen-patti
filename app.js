(() => {
  const $ = id => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'] });
  let S = null;              // latest state from server
  let clockSkew = 0;
  let mode = null;           // null | 'ex-one' | 'swap-card' | 'swap-player'
  let offerIdx = null;
  let shownSwap = null;
  let myToken = localStorage.getItem('tp_token');
  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const RANK = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

  // ------------------------------------------------ join
  function join(name) {
    socket.emit('join', { name, token: myToken }, res => {
      if (!res.ok) {
        if (myToken && !name) { localStorage.removeItem('tp_token'); myToken = null; return; }
        $('joinError').textContent = res.error; return;
      }
      myToken = res.token;
      try { localStorage.setItem('tp_token', res.token); } catch (e) {}
      $('join').classList.add('hidden');
      $('game').classList.remove('hidden');
    });
  }
  $('joinForm').addEventListener('submit', e => {
    e.preventDefault();
    myToken = null;
    join($('nameInput').value);
  });
  socket.on('connect', () => { if (myToken) join(''); });

  // ------------------------------------------------ helpers
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  const reply = res => { if (res && !res.ok) toast(res.error); };
  const act = a => socket.emit('action', a, reply);
  const host = c => socket.emit('host', c, reply);

  function cardEl(c, opts = {}) {
    const d = document.createElement('div');
    if (!c) { d.className = 'card back' + (opts.sm ? ' sm' : ''); return d; }
    const red = c.s === 'H' || c.s === 'D';
    const r = RANK[c.r] || c.r;
    d.className = 'card' + (red ? ' red' : '') + (opts.sm ? ' sm' : '');
    d.innerHTML = `<span class="r">${r}</span><span class="s">${SUIT[c.s]}</span><span class="r2">${r}</span>`;
    return d;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = n => Number(n).toLocaleString('en-IN');

  // ------------------------------------------------ render
  socket.on('state', st => {
    S = st;
    clockSkew = st.serverTime - Date.now();
    if (!st.me) {
      // we were removed
      if (!$('game').classList.contains('hidden')) {
        $('game').classList.add('hidden'); $('join').classList.remove('hidden');
        localStorage.removeItem('tp_token'); myToken = null;
        $('joinError').textContent = 'You were removed from the table.';
      }
      return;
    }
    render();
  });

  function render() {
    const { me, round, players, settings } = S;
    const myTurn = round && round.turn === me.id;
    const turnP = round && players.find(p => p.id === round.turn);

    $('roundNo').textContent = round ? round.no : (S.lastResult ? S.lastResult.no : '-');
    $('pot').textContent = fmt(round ? round.pot : 0);
    $('stake').textContent = round ? fmt(round.stake) : fmt(settings.boot);
    $('shoe').textContent = round ? round.shoe : 260;
    $('playerCount').textContent = `${players.length}/${settings.maxPlayers}`;
    $('meName').textContent = me.name + (S.isHost ? ' (host)' : '');
    $('meChips').textContent = fmt(me.chips);

    // banner
    const b = $('banner');
    if (!round && S.lastResult) {
      b.classList.remove('hidden');
      b.innerHTML = `<div>${esc(S.lastResult.text)}</div>` +
        (settings.autoNext ? '<div class="hint">Next round starts in a few seconds.</div>' : '<div class="hint">Waiting for the host to start the next round.</div>');
      if (S.lastResult.reveal && S.lastResult.reveal.length) {
        const r = document.createElement('div'); r.className = 'reveal';
        S.lastResult.reveal.forEach(x => {
          const w = document.createElement('div');
          w.innerHTML = `<b>${esc(x.name)}</b>&nbsp;`;
          x.hand.forEach(c => w.appendChild(cardEl(c, { sm: true })));
          w.insertAdjacentHTML('beforeend', `&nbsp;<span class="hint">${esc(x.label)}</span>`);
          r.appendChild(w);
        });
        b.appendChild(r);
      }
    } else if (!round) {
      b.classList.remove('hidden');
      b.textContent = S.isHost ? 'You are the host. Open the Host tab and press "Start round" once everyone has joined.' : 'Waiting for the host to start the game.';
    } else b.classList.add('hidden');

    // turn info
    const ti = $('turnInfo');
    ti.className = 'turn-indicator' + (myTurn ? ' mine' : '');
    ti.textContent = !round ? '' : myTurn ? 'Your turn!' : turnP ? `${turnP.name}'s turn` : '';

    // hand
    const hand = $('hand'); hand.innerHTML = '';
    const selectable = me.inRound && me.hand && (mode === 'ex-one' || mode === 'swap-card');
    if (me.inRound || (round && me.hand)) {
      for (let i = 0; i < 3; i++) {
        const el = cardEl(me.hand ? me.hand[i] : null);
        if (selectable) {
          el.classList.add('selectable');
          el.onclick = () => onCardPick(i);
        }
        if (mode === 'swap-player' && offerIdx === i) el.classList.add('selected');
        hand.appendChild(el);
      }
    }
    $('handLabel').textContent = me.inRound ? (me.handLabel || 'Playing blind') : '';

    // actions
    const active = round ? round.active : 0;
    const blindAmt = round ? round.stake : 0;
    const amt = me.seen ? blindAmt * 2 : blindAmt;
    const canRaise = round && round.stake * 2 <= round.stakeCap;
    $('actions').classList.toggle('hidden', !me.inRound);
    $('exchangeBox').classList.toggle('hidden', !me.inRound);
    $('btnSee').classList.toggle('hidden', me.seen);
    $('btnChaal').textContent = `${me.seen ? 'Chaal' : 'Blind'} ${fmt(amt)}`;
    $('btnRaise').textContent = canRaise ? `Raise ${fmt(amt * 2)}` : 'Max stake';
    $('btnChaal').disabled = !myTurn || me.chips < amt;
    $('btnRaise').disabled = !myTurn || !canRaise || me.chips < amt * 2;
    $('btnShow').disabled = !myTurn || active !== 2;
    $('btnShow').textContent = active === 2 ? `Show ${fmt(amt)}` : 'Show';
    $('btnPack').disabled = !me.inRound;

    // exchange
    const fee = round ? round.stake * settings.exchangeFeeMult : 0;
    $('exLeft').textContent = `(${me.exchangesLeft} left)`;
    $('exFee').textContent = fee ? `· fee ${fmt(fee)}` : '· free';
    const exOk = me.inRound && me.exchangesLeft > 0;
    $('btnExOne').disabled = !exOk || !myTurn;
    $('btnExAll').disabled = !exOk || !myTurn;
    $('btnExPlayer').disabled = !exOk || S.swaps.some(s => !s.incoming);
    if (mode && !exOk) mode = null;
    const pending = S.swaps.find(s => !s.incoming);
    $('exHint').innerHTML = mode === 'ex-one' ? 'Tap the card you want to replace. <a href="#" id="cancelMode">Cancel</a>'
      : mode === 'swap-card' ? 'Tap the card you want to offer. <a href="#" id="cancelMode">Cancel</a>'
      : mode === 'swap-player' ? 'Now tap a player in the Table list (glowing green). <a href="#" id="cancelMode">Cancel</a>'
      : pending ? `Waiting for ${esc(pending.toName)} to respond… <a href="#" id="cancelSwap">Cancel</a>`
      : (me.inRound && !me.seen ? 'See your cards to unlock exchanges.' : (me.inRound ? 'Shoe exchanges happen on your turn. Player swaps can be offered any time.' : ''));
    const cm = $('cancelMode'); if (cm) cm.onclick = e => { e.preventDefault(); mode = null; offerIdx = null; render(); };
    const cs = $('cancelSwap'); if (cs) cs.onclick = e => { e.preventDefault(); act({ type: 'swap-cancel' }); };

    // waiting text
    $('waiting').textContent = !round || me.inRound ? '' :
      (players.find(p => p.id === me.id)?.inRound ? 'You packed. Wait for the next round.' : 'You will be dealt in next round.');
    $('btnRebuy').classList.toggle('hidden', me.chips >= settings.boot * 4 || me.inRound);
    $('chkSitOut').checked = me.sittingOut;

    renderGrid(); renderBoard(); renderLog(); renderHost(); renderSwapModal();
  }

  function renderGrid() {
    const { players, round, me } = S;
    const g = $('grid'); g.innerHTML = '';
    players.forEach(p => {
      const d = document.createElement('button');
      d.className = 'seat';
      if (round && round.turn === p.id) d.classList.add('turn');
      if (p.inRound && p.packed) d.classList.add('packed');
      if (!p.inRound && round) d.classList.add('out');
      if (!p.connected) d.classList.add('offline');
      if (p.id === me.id) d.classList.add('me');
      const pickable = mode === 'swap-player' && p.id !== me.id && p.inRound && !p.packed;
      if (pickable) d.classList.add('pickable');
      let status = !round ? (p.sittingOut ? 'Sitting out' : 'Ready')
        : !p.inRound ? 'Waiting' : p.packed ? 'Packed' : (p.lastAction || (p.seen ? 'Seen' : 'Blind'));
      d.innerHTML = `<div class="tags">${round && round.dealer === p.id ? '<span class="tag d">D</span>' : ''}${S.hostId === p.id ? '<span class="tag h">H</span>' : ''}${p.inRound && !p.packed ? `<span class="tag">${p.seen ? 'S' : 'B'}</span>` : ''}</div>
        <div class="nm">${esc(p.name)}</div><div class="ch">${fmt(p.chips)}</div><div class="st">${esc(status)}</div>`;
      d.onclick = () => {
        if (pickable) {
          act({ type: 'swap-request', to: p.id, index: offerIdx });
          mode = null; offerIdx = null; render();
        } else if (S.isHost && p.id !== me.id) hostMenu(p);
      };
      g.appendChild(d);
    });
  }

  function renderBoard() {
    const rows = [...S.players].sort((a, b) => b.net - a.net);
    $('boardBody').innerHTML = rows.map((p, i) =>
      `<tr><td>${i + 1}</td><td>${esc(p.name)}${p.rebuys ? ` <span class="hint">(${p.rebuys} rebuy)</span>` : ''}</td><td>${fmt(p.chips)}</td><td class="${p.net >= 0 ? 'pos' : 'neg'}">${p.net >= 0 ? '+' : ''}${fmt(p.net)}</td></tr>`).join('');
  }

  function renderLog() {
    $('log').innerHTML = [...S.log].reverse().map(l =>
      `<li><time>${new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>${esc(l.text)}</li>`).join('');
  }

  let settingsFilled = false;
  function renderHost() {
    $('hostTab').classList.toggle('hidden', !S.isHost);
    if (!S.isHost) { settingsFilled = false; return; }
    $('hStart').disabled = !!S.round;
    $('hEnd').disabled = !S.round;
    if (!settingsFilled) {
      const f = $('settingsForm');
      for (const [k, v] of Object.entries(S.settings)) {
        const inp = f.elements[k]; if (!inp) continue;
        if (inp.type === 'checkbox') inp.checked = v; else inp.value = v;
      }
      settingsFilled = true;
    }
  }

  function renderSwapModal() {
    const inc = S.swaps.find(s => s.incoming);
    if (!inc) { if (shownSwap) closeModal(); shownSwap = null; return; }
    if (shownSwap === inc.id) return;
    shownSwap = inc.id;
    const card = $('modalCard');
    card.innerHTML = `<h3>Swap request</h3><p><b>${esc(inc.fromName)}</b> wants to swap one card with you (you won't see their card first). Tap one of your cards to give, or decline.</p><div class="hand" id="swapHand"></div><div class="row"><button class="btn red" id="swapNo">Decline</button></div>`;
    const sh = $('swapHand');
    // need to see own cards to choose: ask server to mark seen first
    const drawHand = () => {
      sh.innerHTML = '';
      (S.me.hand || [null, null, null]).forEach((c, i) => {
        const el = cardEl(c); el.classList.add('selectable');
        el.onclick = () => { act({ type: 'swap-reply', requestId: inc.id, accept: true, index: i }); closeModal(); };
        sh.appendChild(el);
      });
    };
    if (!S.me.seen) socket.emit('action', { type: 'see' }, () => setTimeout(drawHand, 150));
    drawHand();
    $('swapNo').onclick = () => { act({ type: 'swap-reply', requestId: inc.id, accept: false }); closeModal(); };
    $('modal').classList.remove('hidden');
  }

  function hostMenu(p) {
    const card = $('modalCard');
    card.innerHTML = `<h3>${esc(p.name)}</h3><p>${fmt(p.chips)} chips</p><div class="row"><button class="btn" id="mHost">Make host</button><button class="btn red" id="mKick">Remove</button></div><div class="row"><button class="btn ghost" id="mClose">Close</button></div>`;
    $('mHost').onclick = () => { host({ type: 'make-host', id: p.id }); closeModal(); };
    $('mKick').onclick = () => { host({ type: 'kick', id: p.id }); closeModal(); };
    $('mClose').onclick = closeModal;
    $('modal').classList.remove('hidden');
  }
  function closeModal() { $('modal').classList.add('hidden'); }

  function onCardPick(i) {
    if (mode === 'ex-one') {
      act({ type: 'exchange-one', index: i }); mode = null; render();
    } else if (mode === 'swap-card') {
      offerIdx = i; mode = 'swap-player';
      document.querySelector('[data-tab="table"]').click();
      render();
    }
  }

  // ------------------------------------------------ buttons
  $('btnSee').onclick = () => act({ type: 'see' });
  $('btnChaal').onclick = () => act({ type: 'chaal', raise: false });
  $('btnRaise').onclick = () => act({ type: 'chaal', raise: true });
  $('btnShow').onclick = () => act({ type: 'show' });
  $('btnPack').onclick = () => { if (confirmPack()) act({ type: 'pack' }); };
  function confirmPack() { return !S.round || S.round.turn === S.me.id || window.confirm('Pack now? You will lose your chips in the pot.'); }
  $('btnExOne').onclick = () => { if (!S.me.seen) return toast('See your cards first.'); mode = 'ex-one'; render(); };
  $('btnExAll').onclick = () => {
    if (!S.me.seen) return toast('See your cards first.');
    act({ type: 'exchange-all' });
  };
  $('btnExPlayer').onclick = () => { if (!S.me.seen) return toast('See your cards first.'); mode = 'swap-card'; render(); };
  $('btnRebuy').onclick = () => socket.emit('rebuy', reply);
  $('chkSitOut').onchange = e => socket.emit('sitout', e.target.checked, reply);

  $('hStart').onclick = () => host({ type: 'start' });
  $('hEnd').onclick = () => { if (confirm('End this round and split the pot among active players?')) host({ type: 'end-round' }); };
  $('hReset').onclick = () => { if (confirm('Reset every player to the starting chips?')) host({ type: 'reset-chips' }); };
  $('settingsForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target, s = {};
    ['boot', 'startChips', 'turnSeconds', 'exchangesPerRound', 'exchangeFeeMult', 'stakeCapMult', 'maxPlayers'].forEach(k => s[k] = Number(f.elements[k].value));
    s.autoNext = f.elements.autoNext.checked;
    host({ type: 'settings', settings: s });
    toast('Settings saved.');
  });

  document.querySelectorAll('.tabs button').forEach(btn => btn.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('hidden', t.id !== 'tab-' + btn.dataset.tab));
    if (btn.dataset.tab === 'host') settingsFilled = false, renderHost();
  });

  // timer bar
  setInterval(() => {
    if (!S || !S.round) { $('timerBar').style.width = '0'; return; }
    const left = S.round.deadline - (Date.now() + clockSkew);
    const pct = Math.max(0, Math.min(100, left / (S.settings.turnSeconds * 1000) * 100));
    $('timerBar').style.width = pct + '%';
    $('timerBar').style.background = pct < 25 ? 'var(--red)' : 'var(--gold)';
  }, 250);
})();
