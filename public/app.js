'use strict';

// ---------- 저장소 & 유틸 ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function bucket(storage, key) {
  return {
    get() { try { return JSON.parse(storage.getItem(key) || '{}'); } catch (e) { return {}; } },
    set(patch) { try { storage.setItem(key, JSON.stringify({ ...this.get(), ...patch })); } catch (e) { /* ignore */ } },
  };
}
// 닉네임은 브라우저 전체에서 기억한다.
const store = bucket(localStorage, 'liar-game');
// 신원과 참가 중인 방은 탭마다 따로 둔다. 같은 탭을 새로고침하면 그대로 이어지고,
// 새 탭에서 초대 링크를 열면 이전 세션을 물려받지 않고 깨끗하게 시작한다.
const session = bucket(sessionStorage, 'liar-game');

const saved = store.get();
const mine = session.get();
const token = mine.token || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
session.set({ token });
const IS_P2P = Net.mode === 'p2p';

const PHASE_LABEL = {
  lobby: '대기실', reveal: '카드 확인', hint: '설명', discuss: '토론', vote: '투표', guess: '최후의 기회', result: '결과',
};

let S = null;            // 마지막 상태
let clockOffset = 0;     // 방장/서버 시각 - 내 시각
let chat = [];
let flipped = {};        // roundNo -> 카드 뒤집힘
let myVote = null;
let lastTurnBeep = null;
let toastTimer = null;

function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function beep(freq = 880, dur = 0.12) {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    o.type = 'sine';
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.stop(ctx.currentTime + dur);
  } catch (e) { /* 소리 없어도 됨 */ }
}

const send = (obj) => Net.send(obj);

// ---------- 네트워크 연결 ----------
Net.onStatus = (ok, text) => {
  const st = $('#connStatus');
  st.textContent = text || (IS_P2P ? '준비됨 · 서버 없이 브라우저끼리 연결돼요' : '서버 연결 중…');
  st.classList.toggle('ok', ok);
  $('#connDot').classList.toggle('ok', ok);
  $('#connDot').title = text || '';
};

Net.onMessage = (m) => {
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'joined':
      store.set({ name: m.name });
      session.set({ code: m.code, role: Net.role });
      showGame(true);
      history.replaceState(null, '', `?room=${m.code}`);
      break;
    case 'state':
      S = m;
      clockOffset = m.now - Date.now();
      chat = m.chat || chat;
      render();
      renderChat();
      break;
    case 'chat':
      chat.push(m.msg);
      if (chat.length > 200) chat.shift();
      appendChat(m.msg);
      break;
    case 'error':
      toast(m.msg, 4500);
      if (m.code === 'no_room' || m.code === 'full') { session.set({ code: null, role: null }); showGame(false); }
      break;
    case 'kicked':
      toast('방장이 당신을 내보냈어요.');
      session.set({ code: null, role: null });
      showGame(false);
      break;
    case 'roomClosed':
      toast('방장이 방을 닫았어요.', 4500);
      session.set({ code: null, role: null });
      showGame(false);
      break;
    case 'left':
      session.set({ code: null, role: null });
      showGame(false);
      break;
    default:
      break;
  }
};

function showGame(on) {
  $('#home').hidden = on;
  $('#game').hidden = !on;
  if (!on) { S = null; chat = []; renderChat(); history.replaceState(null, '', location.pathname); }
}

// ---------- 홈 ----------
$('#nameInput').value = saved.name || '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('#codeInput').value = urlRoom.toUpperCase().slice(0, 4);

function requireName() {
  const name = $('#nameInput').value.trim();
  if (!name) { toast('닉네임을 입력하세요.'); $('#nameInput').focus(); return null; }
  store.set({ name });
  return name;
}

$('#createBtn').addEventListener('click', () => {
  const name = requireName();
  if (!name) return;
  Net.createRoom(name, token);
});

$('#homeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = requireName();
  if (!name) return;
  const code = $('#codeInput').value.trim().toUpperCase();
  if (code.length !== 4) { toast('방 코드 4글자를 입력하세요.'); $('#codeInput').focus(); return; }
  Net.joinRoom(code, name, token);
});

$('#leaveBtn').addEventListener('click', () => {
  const hostClosesRoom = IS_P2P && Net.role === 'host';
  const msg = hostClosesRoom
    ? '나가면 방이 닫히고 다른 사람들도 게임이 끝나요. 정말 나갈까요?'
    : (S && S.phase !== 'lobby' ? '게임 중이에요. 정말 나갈까요?' : null);
  if (msg && !confirm(msg)) return;
  Net.leave();
  session.set({ code: null, role: null });
  showGame(false);
});

// 방장이 실수로 탭을 닫는 것 방지
window.addEventListener('beforeunload', (e) => {
  if (IS_P2P && Net.role === 'host' && S && S.players.length > 1) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------- 채팅 ----------
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  input.value = '';
});

function chatHtml(m) {
  if (m.sys) return `<div class="msg sys">${esc(m.text)}</div>`;
  const me = S && m.id === S.you;
  return `<div class="msg${me ? ' me' : ''}"><span class="who">${esc(m.name)}</span>${esc(m.text)}</div>`;
}

function renderChat() {
  const log = $('#chatLog');
  log.innerHTML = chat.map(chatHtml).join('');
  log.scrollTop = log.scrollHeight;
}

function appendChat(m) {
  const log = $('#chatLog');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.insertAdjacentHTML('beforeend', chatHtml(m));
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

// ---------- 타이머 ----------
setInterval(() => {
  const el = $('#timer');
  if (!S || !S.timer) { el.hidden = true; return; }
  el.hidden = false;
  const remain = Math.max(0, S.timer.endsAt - (Date.now() + clockOffset));
  const ratio = S.timer.total ? remain / S.timer.total : 0;
  const fill = $('#timerFill');
  fill.style.width = `${ratio * 100}%`;
  fill.classList.toggle('low', remain < 10000);
  $('#timerNum').textContent = Math.ceil(remain / 1000);
}, 200);

// ---------- 렌더 ----------
function player(id) { return S.players.find((p) => p.id === id); }
function nameOf(id) { const p = player(id); return p ? p.name : '(나간 사람)'; }
function isHost() { return S && S.hostId === S.you; }

function render() {
  if (!S) return;
  $('#roomCode').textContent = S.code;
  $('#phaseLabel').innerHTML = `${PHASE_LABEL[S.phase] || ''}${S.roundNo ? `<span class="sub">라운드 ${S.roundNo}${S.round ? ` · ${esc(S.round.category)}` : ''}</span>` : ''}`;
  renderPlayers();
  renderStage();
  if (S.phase === 'hint' && S.round && S.round.turnId === S.you) {
    const key = `${S.roundNo}-${S.round.hintRound}`;
    if (lastTurnBeep !== key) { lastTurnBeep = key; beep(); }
  }
  if (S.phase !== 'vote') myVote = null;
}

function renderPlayers() {
  const r = S.round;
  const html = S.players.map((p) => {
    const cls = ['pl'];
    if (p.id === S.you) cls.push('me');
    if (!p.connected) cls.push('off');
    if (r && S.phase === 'hint' && r.turnId === p.id) cls.push('turn');
    if (r && S.phase === 'result' && r.liars && r.liars.includes(p.id)) cls.push('liar');
    const tags = [];
    if (p.isHost) tags.push('<span class="pl-tag host">방장</span>');
    if (r && S.phase === 'result' && r.liars && r.liars.includes(p.id)) tags.push('<span class="pl-tag liar">라이어</span>');
    if (r && !p.participating && S.phase !== 'lobby') tags.push('<span class="pl-tag">관전</span>');
    if (r && S.phase === 'reveal' && p.ready) tags.push('<span class="pl-tag ok">확인</span>');
    if (r && S.phase === 'discuss' && p.calledVote) tags.push('<span class="pl-tag ok">투표?</span>');
    if (r && S.phase === 'vote' && p.voted) tags.push('<span class="pl-tag ok">투표완료</span>');
    const kick = isHost() && S.phase === 'lobby' && p.id !== S.you
      ? `<button class="pl-kick" data-kick="${p.id}" title="내보내기">✕</button>` : '';
    return `<div class="${cls.join(' ')}">
      <span class="pl-dot"></span>
      <span class="pl-name"><span>${esc(p.name)}</span>${tags.join('')}</span>
      <span class="row" style="gap:6px"><span class="pl-score">${p.score}점</span>${kick}</span>
    </div>`;
  }).join('');
  const online = S.players.filter((p) => p.connected).length;
  $('#players').innerHTML = `<div class="players-head"><span>플레이어</span><span class="tabular">${online}/${S.players.length}</span></div>${html}`;
}

function myWordChip() {
  if (!S.me) return '';
  if (S.me.role === 'liar') {
    return `<div class="my-word liar">당신은 <b>라이어</b><span class="muted">카테고리: ${esc(S.round.category)}</span></div>`;
  }
  return `<div class="my-word citizen">제시어 <b>${esc(S.me.word)}</b><span class="muted">${esc(S.round.category)}</span></div>`;
}

function hostBar(buttons) {
  if (!isHost()) return '';
  return `<div class="host-actions">${buttons}</div>`;
}

function renderStage() {
  const stage = $('#stage');
  const hintEl = $('#hintInput');
  const keep = hintEl ? { value: hintEl.value, focus: document.activeElement === hintEl } : null;

  const fn = { lobby: stageLobby, reveal: stageReveal, hint: stageHint, discuss: stageDiscuss, vote: stageVote, guess: stageGuess, result: stageResult }[S.phase];
  stage.innerHTML = fn ? fn() : '';

  const newHint = $('#hintInput');
  if (newHint && keep) { newHint.value = keep.value; if (keep.focus) newHint.focus(); }
  else if (newHint && S.round && S.round.turnId === S.you && window.innerWidth > 960) newHint.focus();
}

// --- 로비 ---
function stageLobby() {
  const s = S.settings;
  const host = isHost();
  const online = S.players.filter((p) => p.connected).length;
  const link = `${location.origin}${location.pathname}?room=${S.code}`;
  const seg = (key, opts) => `<div class="seg">${opts.map(([v, label]) =>
    `<button type="button" data-set="${key}" data-val="${JSON.stringify(v).replace(/"/g, '&quot;')}" class="${s[key] === v ? 'on' : ''}" ${host ? '' : 'disabled'}>${label}</button>`).join('')}</div>`;
  const num = (key, label, opts) => `<label class="setting"><span>${label}</span>${host
    ? `<select data-set="${key}">${opts.map((v) => `<option value="${v}" ${s[key] === v ? 'selected' : ''}>${v}초</option>`).join('')}</select>`
    : `<span class="val">${s[key]}초</span>`}</label>`;
  const catOpts = [['random', '랜덤'], ...S.categories.map((c) => [c.key, c.name])];
  const p2pNote = IS_P2P && Net.role === 'host'
    ? '<div class="banner note">이 브라우저 탭이 방을 유지해요. 게임이 끝날 때까지 닫지 마세요.</div>'
    : '';

  return `
  <div class="panel">
    <div class="invite">
      <div>
        <div class="eyebrow">초대 코드</div>
        <div class="invite-code">${S.code}</div>
        <div class="help">링크를 보내면 코드 없이 바로 들어와요.</div>
      </div>
      <div class="invite-actions">
        <button class="btn primary" data-copy="${esc(link)}">초대 링크 복사</button>
        <button class="btn ghost" data-copy="${S.code}">코드만 복사</button>
      </div>
    </div>
    ${p2pNote}
  </div>
  <div class="panel">
    <h2>게임 설정</h2>
    <p class="help">${host ? '방장만 바꿀 수 있어요.' : '방장이 설정을 정하는 중이에요.'}</p>
    <div class="settings-grid">
      <label class="setting"><span>카테고리</span>${host
        ? `<select data-set="category">${catOpts.map(([v, l]) => `<option value="${v}" ${s.category === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`
        : `<span class="val">${esc((catOpts.find(([v]) => v === s.category) || ['', '?'])[1])}</span>`}</label>
      <div class="setting"><span>라이어 수 <span class="muted">(6명 이상일 때 2명 가능)</span></span>${seg('liarCount', [[1, '1명'], [2, '2명']])}</div>
      <div class="setting"><span>바보 모드 <span class="muted">(라이어도 자기가 라이어인 줄 모름)</span></span>${seg('fool', [[false, '끔'], [true, '켬']])}</div>
      <div class="setting"><span>라이어 최후 추리 <span class="muted">(항상: 안 잡혀도 제시어를 맞혀야 승리)</span></span>${seg('liarGuess', [['always', '항상'], ['caught', '지목됐을 때만']])}</div>
      <div class="setting"><span>설명 바퀴 수</span>${seg('hintRounds', [[1, '1바퀴'], [2, '2바퀴']])}</div>
      ${num('hintTime', '설명 시간 (1인당)', [15, 20, 30, 45, 60, 90])}
      ${num('discussTime', '토론 시간', [30, 60, 90, 120, 180, 300])}
      ${num('voteTime', '투표 시간', [15, 20, 30, 45, 60])}
      ${num('guessTime', '라이어 정답 시간', [15, 20, 30, 45, 60])}
    </div>
  </div>
  <div class="panel row spread">
    <div><b class="tabular">${online}명</b> 접속 중 <span class="help">· 최소 3명, 최대 12명</span></div>
    ${host
      ? `<button class="btn primary big" data-act="start" ${online < 3 ? 'disabled' : ''}>게임 시작</button>`
      : '<span class="help">방장이 시작하길 기다리는 중…</span>'}
  </div>`;
}

// --- 카드 확인 ---
function stageReveal() {
  if (!S.me) return `<div class="panel"><h2>관전 중</h2><p class="help">이번 라운드는 구경만! 다음 라운드부터 참여해요.</p></div>`;
  const key = S.roundNo;
  const isFlipped = Boolean(flipped[key]);
  const me = player(S.you);
  const readyN = S.players.filter((p) => p.participating && p.ready).length;
  const totalN = S.players.filter((p) => p.participating && p.connected).length;
  const back = S.me.role === 'liar'
    ? `<div class="card-face card-back liar"><div><div class="card-role">라이어</div><div class="card-cat">카테고리</div><div class="card-word">${esc(S.round.category)}</div><div class="card-note">제시어를 모릅니다. 남들 설명을 듣고 눈치껏 아는 척하세요.</div></div></div>`
    : `<div class="card-face card-back citizen"><div><div class="card-role">시민</div><div class="card-cat">${esc(S.round.category)}</div><div class="card-word">${esc(S.me.word)}</div><div class="card-note">라이어가 눈치채지 못하게, 하지만 시민끼리는 알아듣게 설명하세요.</div></div></div>`;
  return `
  <div class="panel">
    <h2>라운드 ${S.roundNo} · 카드를 확인하세요</h2>
    <p class="help">카드를 탭해서 뒤집으세요. 옆사람 화면 훔쳐보기 금지!</p>
    <div class="card-wrap">
      <div class="card ${isFlipped ? 'flipped' : ''}" data-flip="${key}">
        <div class="card-inner">
          <div class="card-face card-front"><div>LIAR<br>GAME<small>탭해서 확인</small></div></div>
          ${back}
        </div>
      </div>
      <button class="btn primary" data-act="ready" ${me && me.ready ? 'disabled' : ''}>${me && me.ready ? '확인 완료 · 기다리는 중' : '확인했어요'}</button>
      <div class="help tabular">${readyN}/${totalN}명 확인</div>
    </div>
    ${hostBar('<button class="btn ghost small" data-act="skip">바로 설명 단계로</button>')}
  </div>`;
}

// --- 설명 ---
function hintsBlock(r, showRounds = true) {
  if (!r.hints.length) return '<div class="help">아직 설명이 없어요.</div>';
  const rounds = {};
  for (const h of r.hints) (rounds[h.round] = rounds[h.round] || []).push(h);
  return Object.entries(rounds).map(([n, hs]) => `
    ${showRounds && r.hintRounds > 1 ? `<div class="hint-round">${n}바퀴</div>` : ''}
    <div class="hints">${hs.map((h) => `<div class="hint"><span class="hint-name">${esc(nameOf(h.id))}</span><span class="hint-text ${h.text ? '' : 'pass'}">${h.text ? esc(h.text) : '(패스)'}</span></div>`).join('')}</div>`).join('');
}

function stageHint() {
  const r = S.round;
  const myTurn = r.turnId === S.you;
  const doneIds = new Set(r.hints.filter((h) => h.round === r.hintRound).map((h) => h.id));
  const strip = r.order.map((id) => `<span class="order-chip ${id === r.turnId ? 'now' : doneIds.has(id) ? 'done' : ''}">${esc(nameOf(id))}</span>`).join('');
  return `
  <div class="panel">
    <div class="row spread">
      <h2>설명 단계${r.hintRounds > 1 ? ` · ${r.hintRound}/${r.hintRounds}바퀴` : ''}</h2>
      ${myWordChip()}
    </div>
    <div class="order-strip">${strip}</div>
  </div>
  <div class="panel">
    ${myTurn
      ? `<div class="turn-banner">당신 차례!</div>
         <p class="help">제시어를 한 줄로 설명하세요. 너무 쉬우면 라이어가, 너무 어려우면 시민이 헷갈려요.</p>
         <form class="hint-form" id="hintForm"><input id="hintInput" maxlength="60" placeholder="예: 겨울에 특히 생각나는 것" autocomplete="off"><button class="btn primary" type="submit">제출</button></form>`
      : `<div class="turn-banner wait"><b>${esc(nameOf(r.turnId))}</b>님이 설명하는 중…</div>`}
    ${hostBar('<button class="btn ghost small" data-act="skip">이 사람 차례 건너뛰기</button>')}
  </div>
  <div class="panel"><h3>지금까지 설명</h3>${hintsBlock(r)}</div>`;
}

// --- 토론 ---
function stageDiscuss() {
  const r = S.round;
  const me = player(S.you);
  const alive = S.players.filter((p) => p.participating && p.connected).length;
  return `
  <div class="panel">
    <div class="row spread"><h2>토론</h2>${myWordChip()}</div>
    <p>채팅으로 서로 추궁하세요. 누구 설명이 이상했나요?</p>
    <div class="row">
      ${S.me ? `<button class="btn" data-act="callVote" ${me && me.calledVote ? 'disabled' : ''}>${me && me.calledVote ? '투표 요청함' : '투표하러 가기'}</button>` : ''}
      <span class="help tabular">${r.voteCallCount}/${alive}명 요청 · 과반이면 바로 투표</span>
      ${hostBar('<button class="btn danger small" data-act="skip">지금 투표 시작</button>')}
    </div>
  </div>
  <div class="panel"><h3>설명 다시 보기</h3>${hintsBlock(r)}</div>`;
}

// --- 투표 ---
function tallyBlock(t, ids) {
  if (!t) return '';
  const max = Math.max(1, ...Object.values(t.counts));
  const rows = ids.filter((id) => t.counts[id]).sort((a, b) => t.counts[b] - t.counts[a]).map((id) => {
    const voters = Object.entries(t.votes).filter(([, target]) => target === id).map(([v]) => nameOf(v));
    return `<div class="tally-row"><span>${esc(nameOf(id))}</span><div class="tally-bar"><div class="tally-fill" style="width:${(t.counts[id] / max) * 100}%"></div></div><span class="tally-n">${t.counts[id]}표</span><span class="tally-voters">${esc(voters.join(', '))}</span></div>`;
  }).join('');
  return `<div class="tally">${rows || '<div class="help">표 없음</div>'}</div>`;
}

function stageVote() {
  const r = S.round;
  const candidates = (r.voteCandidates || r.order).filter((id) => player(id));
  const voted = S.players.filter((p) => p.participating && p.voted).length;
  const alive = S.players.filter((p) => p.participating && p.connected).length;
  const canVote = Boolean(S.me);
  const grid = candidates.map((id) => {
    const p = player(id);
    const self = id === S.you;
    return `<button class="vote-btn ${myVote === id ? 'on' : ''}" data-vote="${id}" ${!canVote || self ? 'disabled' : ''}>${esc(p.name)}${self ? ' (나)' : ''}${!p.connected ? ' <span class="n">오프라인</span>' : ''}</button>`;
  }).join('');
  return `
  <div class="panel">
    <div class="row spread"><h2>${r.voteCandidates ? '재투표' : '투표'}</h2>${myWordChip()}</div>
    ${r.voteCandidates ? '<div class="banner warn">동률이 나왔어요. 아래 사람들 중에서 다시 고르세요. 또 동률이면 라이어 승리!</div>' : ''}
    <p class="help">라이어라고 생각하는 사람을 고르세요. 바꿀 수 있어요. <span class="tabular">${voted}/${alive}명 투표</span></p>
    <div class="vote-grid">${grid}</div>
    ${hostBar('<button class="btn ghost small" data-act="skip">투표 마감</button>')}
  </div>
  ${r.voteCandidates && r.lastTally ? `<div class="panel"><h3>1차 투표 결과</h3>${tallyBlock(r.lastTally, r.order)}</div>` : ''}
  <div class="panel"><h3>설명 다시 보기</h3>${hintsBlock(r)}</div>`;
}

// --- 최후의 기회 ---
function stageGuess() {
  const r = S.round;
  const mine = r.guessOptions;
  const myTurn = mine
    ? (r.caught
      ? '당신이 라이어로 지목됐어요! 시민들의 설명을 떠올려 제시어를 고르세요. 맞히면 역전승.'
      : '들키지 않았어요! 하지만 제시어까지 맞혀야 이깁니다. 설명을 떠올려 고르세요.')
    : null;
  const watching = r.caught
    ? `<b>${esc(nameOf(r.guesser))}</b>님이 라이어였어요! 지금 제시어를 맞히는 중… 맞히면 라이어 승리.`
    : `라이어를 잡지 못했어요. 하지만 <b>${esc(nameOf(r.guesser))}</b>님이 제시어를 맞혀야 라이어가 이깁니다.`;
  return `
  <div class="panel">
    <h2>최후의 기회</h2>
    ${mine
      ? `<div class="banner warn">${myTurn}</div>
         <div class="guess-grid" style="margin-top:12px">${mine.map((w) => `<button class="guess-btn" data-guess="${esc(w)}">${esc(w)}</button>`).join('')}</div>`
      : `<div class="banner gold">${watching}</div>`}
  </div>
  <div class="panel"><h3>투표 결과</h3>${tallyBlock(r.lastTally, r.order)}</div>
  <div class="panel"><h3>설명 다시 보기</h3>${hintsBlock(r)}</div>`;
}

// --- 결과 ---
function stageResult() {
  const r = S.round;
  const liarNames = r.liars.map(nameOf).join(', ');
  const guesserName = r.guesser ? nameOf(r.guesser) : liarNames;
  const title = {
    citizens_win: ['시민 승리', 'citizens'],
    liar_guessed: ['라이어 역전승', 'liar'],
    liar_escaped: [r.reason === 'escaped_guess' ? '라이어 완승' : '라이어 승리', 'liar'],
  }[r.outcome];
  const reason = {
    wrong_guess: `${guesserName}님이 "${r.guess}"라고 답했지만 틀렸어요.`,
    escaped_wrong: `라이어를 못 잡았지만, ${guesserName}님이 "${r.guess}"라고 답해 제시어를 끝내 몰랐어요.`,
    guess: `${guesserName}님이 지목당했지만 제시어를 정확히 맞혔어요.`,
    escaped_guess: `${guesserName}님이 들키지도 않고 제시어까지 맞혔어요.`,
    timeout: '라이어가 시간 안에 답하지 못했어요.',
    wrong_pick: `${r.accused ? nameOf(r.accused) : '지목된 사람'}님은 라이어가 아니었어요.`,
    tie: '재투표까지 동률이라 라이어를 못 잡았어요.',
    no_vote: '아무도 투표하지 않았어요.',
  }[r.reason] || '';
  const rows = S.players.slice().sort((a, b) => b.score - a.score).map((p) => {
    const d = r.deltas[p.id] || 0;
    const isLiar = r.liars.includes(p.id);
    return `<tr><td>${esc(p.name)}${p.id === S.you ? ' <span class="muted">(나)</span>' : ''}</td><td>${isLiar ? '<span class="role-liar">라이어</span>' : p.participating ? '시민' : '<span class="muted">관전</span>'}</td><td class="delta ${d ? '' : 'zero'}">${d ? `+${d}` : '·'}</td><td>${p.score}점</td></tr>`;
  }).join('');
  return `
  <div class="panel">
    <div class="result-head">
      <div class="result-title ${title[1]}">${title[0]}</div>
      <div class="result-word">제시어는 <b>${esc(r.word)}</b>${r.foolWord ? ` <span class="muted">(라이어가 받은 단어: ${esc(r.foolWord)})</span>` : ''}</div>
      <div>라이어: <span class="role-liar">${esc(liarNames)}</span></div>
      <div class="help">${esc(reason)}</div>
    </div>
    ${hostBar('<button class="btn primary big" data-act="next">다음 라운드</button><button class="btn" data-act="lobby">로비로 (설정 변경)</button>')}
    ${isHost() ? '' : '<div class="help">방장이 다음 라운드를 시작하길 기다리는 중…</div>'}
  </div>
  <div class="panel"><h3>점수</h3><table class="score-table">${rows}</table></div>
  ${r.lastTally ? `<div class="panel"><h3>투표 결과</h3>${tallyBlock(r.lastTally, r.order)}</div>` : ''}
  <div class="panel"><h3>이번 라운드 설명</h3>${hintsBlock(r)}</div>`;
}

// ---------- 이벤트 위임 ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act],[data-copy],[data-flip],[data-vote],[data-guess],[data-set],[data-kick]');
  if (!t || !S) return;
  if (t.dataset.act) return send({ t: t.dataset.act });
  if (t.dataset.copy !== undefined) {
    navigator.clipboard?.writeText(t.dataset.copy).then(() => toast('복사했어요!'), () => toast(t.dataset.copy, 6000));
    return;
  }
  if (t.dataset.flip !== undefined) {
    flipped[t.dataset.flip] = !flipped[t.dataset.flip];
    t.classList.toggle('flipped', flipped[t.dataset.flip]);
    return;
  }
  if (t.dataset.vote) {
    myVote = t.dataset.vote;
    send({ t: 'vote', target: myVote });
    document.querySelectorAll('.vote-btn').forEach((b) => b.classList.toggle('on', b.dataset.vote === myVote));
    return;
  }
  if (t.dataset.guess !== undefined) {
    if (confirm(`"${t.dataset.guess}"(으)로 확정할까요?`)) send({ t: 'guess', word: t.dataset.guess });
    return;
  }
  if (t.dataset.set && t.tagName === 'BUTTON') {
    return send({ t: 'settings', settings: { [t.dataset.set]: JSON.parse(t.dataset.val) } });
  }
  if (t.dataset.kick) {
    if (confirm(`${nameOf(t.dataset.kick)}님을 내보낼까요?`)) send({ t: 'kick', id: t.dataset.kick });
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.tagName === 'SELECT' && t.dataset.set) {
    const v = t.dataset.set === 'category' ? t.value : Number(t.value);
    send({ t: 'settings', settings: { [t.dataset.set]: v } });
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'hintForm') return;
  e.preventDefault();
  const input = $('#hintInput');
  const text = input.value.trim();
  if (!text) return;
  send({ t: 'hint', text });
  input.value = '';
});

// ---------- 시작 ----------
Net.init();

// 초대 링크가 이전 세션보다 우선한다. 다른 방 링크를 눌렀는데 이 탭이 옛 방으로
// 되돌아가면 링크를 보낸 쪽과 영영 만나지 못한다.
let resumeCode = mine.code || null;
let resumeRole = mine.role || null;
if (urlRoom && urlRoom.toUpperCase() !== resumeCode) {
  resumeCode = null;
  resumeRole = null;
  session.set({ code: null, role: null });
}
Net.resume({ code: resumeCode, name: saved.name || '', token, role: resumeRole });
