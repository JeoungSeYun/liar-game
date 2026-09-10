'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { CATEGORIES } = require('./words');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 3;
const REVEAL_MS = 25000;
const DEFAULT_SETTINGS = {
  category: 'random',
  liarCount: 1,
  fool: false,
  hintRounds: 1,
  hintTime: 30,
  discussTime: 90,
  voteTime: 30,
  guessTime: 30,
};
const TIME_LIMITS = {
  hintTime: [10, 120],
  discussTime: [30, 600],
  voteTime: [10, 120],
  guessTime: [10, 120],
};
const SCORE = { citizen: 1, liarGuessed: 2, liarOtherOnGuess: 1, liarEscaped: 3 };

// ---------- 정적 파일 서버 ----------
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- 유틸 ----------
const rooms = new Map();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const cleanText = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanName = (s) => cleanText(s, 12);
const shortId = () => crypto.randomBytes(4).toString('hex');

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function sendTo(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ---------- 방 ----------
class Room {
  constructor(code) {
    this.code = code;
    this.hostId = null;
    this.players = new Map(); // id -> player
    this.settings = { ...DEFAULT_SETTINGS };
    this.phase = 'lobby';
    this.round = null;
    this.roundNo = 0;
    this.chat = [];
    this.timer = null;
    this.timerInfo = null;
    this.usedWords = new Set();
    this.emptySince = null;
  }

  // ----- 플레이어 -----
  addPlayer(name, token, ws) {
    const p = {
      id: shortId(),
      token,
      name,
      ws,
      connected: true,
      score: 0,
      joinedAt: Date.now(),
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.emptySince = null;
    this.say(`${p.name}님이 입장했어요.`);
    return p;
  }

  findByToken(token) {
    for (const p of this.players.values()) if (p.token === token) return p;
    return null;
  }

  rebind(p, ws, name) {
    if (p.ws && p.ws !== ws) {
      const old = p.ws;
      old.player = null;
      old.room = null;
      try { old.close(); } catch (e) { /* ignore */ }
    }
    p.ws = ws;
    p.connected = true;
    if (name && name !== p.name) {
      this.say(`${p.name}님이 이름을 ${name}(으)로 바꿨어요.`);
      p.name = name;
    } else {
      this.say(`${p.name}님이 다시 접속했어요.`);
    }
    this.emptySince = null;
  }

  removePlayer(p, reason) {
    if (!this.players.has(p.id)) return;
    this.players.delete(p.id);
    if (reason) this.say(`${p.name}님이 ${reason}.`);
    if (this.hostId === p.id) this.migrateHost();
    if (this.round) {
      // 진행 중이면 참가자에서 빼고 흐름 정리
      this.round.participants = this.round.participants.filter((id) => id !== p.id);
      this.afterPlayerGone(p.id);
    }
    if (this.players.size === 0) {
      this.clearTimer();
      rooms.delete(this.code);
      return;
    }
    this.broadcast();
  }

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  migrateHost() {
    const next = this.connectedPlayers()[0] || [...this.players.values()][0];
    this.hostId = next ? next.id : null;
    if (next) this.say(`${next.name}님이 새 방장이 됐어요.`);
  }

  onDisconnect(p, ws) {
    if (p.ws !== ws) return; // 이미 다른 소켓으로 재접속함
    p.ws = null;
    p.connected = false;
    this.say(`${p.name}님의 연결이 끊겼어요.`);

    if (this.phase === 'lobby') {
      setTimeout(() => {
        if (!p.connected && this.players.get(p.id) === p) this.removePlayer(p, '나갔어요');
      }, 15000);
    }
    if (this.hostId === p.id) {
      setTimeout(() => {
        if (!p.connected && this.hostId === p.id && this.players.size > 1) {
          this.migrateHost();
          this.broadcast();
        }
      }, 5000);
    }
    if (this.connectedPlayers().length === 0) {
      this.emptySince = Date.now();
      setTimeout(() => {
        if (this.emptySince && Date.now() - this.emptySince >= 10 * 60 * 1000 - 100) {
          this.clearTimer();
          rooms.delete(this.code);
        }
      }, 10 * 60 * 1000);
    }
    this.afterPlayerGone(p.id);
    this.broadcast();
  }

  // 끊기거나 나간 플레이어 때문에 멈추지 않도록 단계 정리
  afterPlayerGone(id) {
    const r = this.round;
    if (!r) return;
    if (this.phase === 'reveal') this.checkAllReady();
    else if (this.phase === 'hint' && r.order[r.turnIdx] === id) this.passTurn(id);
    else if (this.phase === 'discuss') this.checkVoteCall();
    else if (this.phase === 'vote') this.checkAllVoted();
  }

  // ----- 채팅 -----
  say(text) {
    this.pushChat({ sys: true, text, ts: Date.now() });
  }

  pushChat(msg) {
    this.chat.push(msg);
    if (this.chat.length > 200) this.chat.splice(0, this.chat.length - 200);
    for (const p of this.players.values()) sendTo(p.ws, { t: 'chat', msg });
  }

  // ----- 타이머 -----
  setTimer(ms, fn) {
    this.clearTimer();
    this.timerInfo = { endsAt: Date.now() + ms, total: ms };
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerInfo = null;
      fn();
    }, ms);
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerInfo = null;
  }

  // ----- 설정 -----
  updateSettings(s) {
    if (this.phase !== 'lobby' || !s || typeof s !== 'object') return;
    const out = { ...this.settings };
    if (s.category === 'random' || CATEGORIES[s.category]) out.category = s.category;
    if (s.liarCount === 1 || s.liarCount === 2) out.liarCount = s.liarCount;
    if (typeof s.fool === 'boolean') out.fool = s.fool;
    if (s.hintRounds === 1 || s.hintRounds === 2) out.hintRounds = s.hintRounds;
    for (const k of Object.keys(TIME_LIMITS)) {
      if (Number.isFinite(s[k])) out[k] = clamp(Math.round(s[k]), TIME_LIMITS[k][0], TIME_LIMITS[k][1]);
    }
    this.settings = out;
    this.broadcast();
  }

  // ----- 게임 흐름 -----
  startGame() {
    if (this.phase !== 'lobby') return '이미 게임이 진행 중이에요.';
    if (this.connectedPlayers().length < MIN_PLAYERS) return `최소 ${MIN_PLAYERS}명이 필요해요.`;
    for (const p of this.players.values()) p.score = 0;
    this.roundNo = 0;
    this.usedWords.clear();
    this.startRound();
    return null;
  }

  startRound() {
    const active = this.connectedPlayers().map((p) => p.id);
    if (active.length < MIN_PLAYERS) {
      this.say(`인원이 부족해서 로비로 돌아가요. (최소 ${MIN_PLAYERS}명)`);
      this.toLobby();
      return;
    }
    this.roundNo += 1;
    const catKey = this.settings.category === 'random'
      ? pick(Object.keys(CATEGORIES))
      : this.settings.category;
    const cat = CATEGORIES[catKey];
    let avail = cat.words.filter((w) => !this.usedWords.has(w));
    if (avail.length < 2) {
      for (const w of cat.words) this.usedWords.delete(w);
      avail = cat.words.slice();
    }
    const word = pick(avail);
    this.usedWords.add(word);
    const foolWord = this.settings.fool ? pick(cat.words.filter((w) => w !== word)) : null;

    const maxLiars = Math.max(1, Math.floor((active.length - 1) / 3));
    const liarCount = Math.min(this.settings.liarCount, maxLiars);
    const shuffled = shuffle(active);
    const liars = shuffled.slice(0, liarCount);

    this.round = {
      no: this.roundNo,
      catKey,
      catName: cat.name,
      word,
      foolWord,
      liars,
      participants: active,
      order: shuffle(active),
      hintRound: 1,
      turnIdx: 0,
      hints: [],
      ready: new Set(),
      voteCalls: new Set(),
      votes: {},
      lastTally: null,
      revoteCandidates: null,
      revoted: false,
      accused: null,
      guessOptions: null,
      guess: null,
      outcome: null,
      reason: null,
      deltas: {},
    };
    this.phase = 'reveal';
    this.say(`라운드 ${this.roundNo} 시작! 카테고리: ${cat.name}`);
    this.setTimer(REVEAL_MS, () => this.startHints());
    this.broadcast();
  }

  ready(p) {
    const r = this.round;
    if (this.phase !== 'reveal' || !r || !r.participants.includes(p.id)) return;
    r.ready.add(p.id);
    this.checkAllReady();
    this.broadcast();
  }

  checkAllReady() {
    const r = this.round;
    if (this.phase !== 'reveal' || !r) return;
    const need = r.participants.filter((id) => this.players.get(id)?.connected);
    if (need.every((id) => r.ready.has(id))) this.startHints();
  }

  startHints() {
    const r = this.round;
    if (!r) return;
    this.phase = 'hint';
    r.turnIdx = 0;
    r.hintRound = 1;
    this.say('설명 단계! 순서대로 제시어를 한 줄로 설명하세요. 라이어에게 들키지 않게.');
    this.nextTurn();
  }

  nextTurn() {
    const r = this.round;
    for (;;) {
      if (r.turnIdx >= r.order.length) {
        r.turnIdx = 0;
        r.hintRound += 1;
        if (r.hintRound > this.settings.hintRounds) {
          this.startDiscuss();
          return;
        }
        this.say(`설명 ${r.hintRound}바퀴째!`);
      }
      const pid = r.order[r.turnIdx];
      const p = this.players.get(pid);
      if (!p || !p.connected || !r.participants.includes(pid)) {
        r.hints.push({ id: pid, text: null, round: r.hintRound });
        r.turnIdx += 1;
        continue;
      }
      break;
    }
    const current = r.order[r.turnIdx];
    this.setTimer(this.settings.hintTime * 1000, () => this.passTurn(current));
    this.broadcast();
  }

  passTurn(expectedId) {
    const r = this.round;
    if (this.phase !== 'hint' || !r || r.order[r.turnIdx] !== expectedId) return;
    r.hints.push({ id: expectedId, text: null, round: r.hintRound });
    r.turnIdx += 1;
    this.nextTurn();
  }

  submitHint(p, text) {
    const r = this.round;
    if (this.phase !== 'hint' || !r || r.order[r.turnIdx] !== p.id) return;
    const t = cleanText(text, 60);
    if (!t) return;
    r.hints.push({ id: p.id, text: t, round: r.hintRound });
    r.turnIdx += 1;
    this.nextTurn();
  }

  startDiscuss() {
    const r = this.round;
    this.phase = 'discuss';
    r.voteCalls.clear();
    this.say('토론 시간! 누가 라이어일까요? 채팅으로 추궁하세요.');
    this.setTimer(this.settings.discussTime * 1000, () => this.startVote(null));
    this.broadcast();
  }

  callVote(p) {
    const r = this.round;
    if (this.phase !== 'discuss' || !r || !r.participants.includes(p.id)) return;
    r.voteCalls.add(p.id);
    this.checkVoteCall();
    this.broadcast();
  }

  checkVoteCall() {
    const r = this.round;
    if (this.phase !== 'discuss' || !r) return;
    const alive = r.participants.filter((id) => this.players.get(id)?.connected);
    const calls = alive.filter((id) => r.voteCalls.has(id)).length;
    if (alive.length > 0 && calls * 2 > alive.length) {
      this.say('과반수가 투표를 원해서 바로 투표로 넘어가요.');
      this.startVote(null);
    }
  }

  startVote(candidates) {
    const r = this.round;
    this.phase = 'vote';
    r.votes = {};
    r.revoteCandidates = candidates;
    if (candidates) this.say('동률! 동률인 사람들 중에서 다시 투표해요.');
    else this.say('투표 시작! 라이어라고 생각하는 사람을 고르세요.');
    this.setTimer(this.settings.voteTime * 1000, () => this.tally());
    this.broadcast();
  }

  vote(p, targetId) {
    const r = this.round;
    if (this.phase !== 'vote' || !r || !r.participants.includes(p.id)) return;
    if (!this.players.has(targetId) || !r.participants.includes(targetId) || targetId === p.id) return;
    if (r.revoteCandidates && !r.revoteCandidates.includes(targetId)) return;
    r.votes[p.id] = targetId;
    this.checkAllVoted();
    this.broadcast();
  }

  checkAllVoted() {
    const r = this.round;
    if (this.phase !== 'vote' || !r) return;
    const alive = r.participants.filter((id) => this.players.get(id)?.connected);
    if (alive.length > 0 && alive.every((id) => r.votes[id])) this.tally();
  }

  tally() {
    const r = this.round;
    if (this.phase !== 'vote' || !r) return;
    this.clearTimer();
    const counts = {};
    for (const target of Object.values(r.votes)) counts[target] = (counts[target] || 0) + 1;
    r.lastTally = { counts, votes: { ...r.votes } };
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      this.say('아무도 투표하지 않았어요.');
      return this.finish('liar_escaped', 'no_vote');
    }
    const top = entries[0][1];
    const tied = entries.filter(([, n]) => n === top).map(([id]) => id);
    if (tied.length > 1) {
      if (!r.revoted) {
        r.revoted = true;
        return this.startVote(tied);
      }
      this.say('다시 투표해도 동률이에요. 라이어가 빠져나갔어요!');
      return this.finish('liar_escaped', 'tie');
    }
    r.accused = tied[0];
    const accusedName = this.players.get(r.accused)?.name || '?';
    if (r.liars.includes(r.accused)) {
      this.say(`${accusedName}님이 지목됐어요. 정체는... 라이어! 마지막 기회, 제시어를 맞혀보세요.`);
      return this.startGuess();
    }
    this.say(`${accusedName}님이 지목됐어요. 하지만 라이어가 아니었어요!`);
    return this.finish('liar_escaped', 'wrong_pick');
  }

  startGuess() {
    const r = this.round;
    this.phase = 'guess';
    const pool = CATEGORIES[r.catKey].words.filter((w) => w !== r.word && w !== r.foolWord);
    r.guessOptions = shuffle([r.word, ...shuffle(pool).slice(0, 15)]);
    this.setTimer(this.settings.guessTime * 1000, () => this.finish('citizens_win', 'timeout'));
    this.broadcast();
  }

  guess(p, word) {
    const r = this.round;
    if (this.phase !== 'guess' || !r || p.id !== r.accused) return;
    if (!r.guessOptions.includes(word)) return;
    r.guess = word;
    if (word === r.word) this.finish('liar_guessed', 'guess');
    else this.finish('citizens_win', 'wrong_guess');
  }

  finish(outcome, reason) {
    const r = this.round;
    if (!r || this.phase === 'result') return;
    this.clearTimer();
    this.phase = 'result';
    r.outcome = outcome;
    r.reason = reason;
    const deltas = {};
    const add = (id, n) => {
      const p = this.players.get(id);
      if (!p) return;
      p.score += n;
      deltas[id] = (deltas[id] || 0) + n;
    };
    if (outcome === 'citizens_win') {
      for (const id of r.participants) if (!r.liars.includes(id)) add(id, SCORE.citizen);
    } else if (outcome === 'liar_guessed') {
      for (const id of r.liars) add(id, id === r.accused ? SCORE.liarGuessed : SCORE.liarOtherOnGuess);
    } else if (outcome === 'liar_escaped') {
      for (const id of r.liars) add(id, SCORE.liarEscaped);
    }
    r.deltas = deltas;
    const liarNames = r.liars.map((id) => this.players.get(id)?.name || '?').join(', ');
    const label = { citizens_win: '시민 승리!', liar_guessed: '라이어가 제시어를 맞혔어요!', liar_escaped: '라이어 승리!' }[outcome];
    this.say(`${label} 제시어는 "${r.word}", 라이어는 ${liarNames}.`);
    this.broadcast();
  }

  nextRound() {
    if (this.phase !== 'result') return;
    this.startRound();
  }

  toLobby() {
    this.clearTimer();
    this.phase = 'lobby';
    this.round = null;
    this.broadcast();
  }

  hostSkip() {
    const r = this.round;
    if (!r) return;
    if (this.phase === 'reveal') this.startHints();
    else if (this.phase === 'hint') this.passTurn(r.order[r.turnIdx]);
    else if (this.phase === 'discuss') this.startVote(null);
    else if (this.phase === 'vote') this.tally();
  }

  // ----- 상태 전송 -----
  stateFor(p) {
    const r = this.round;
    const result = this.phase === 'result';
    let me = null;
    if (r && r.participants.includes(p.id)) {
      const isLiar = r.liars.includes(p.id);
      if (isLiar && this.settings.fool && !result && !(this.phase === 'guess' && r.accused === p.id)) {
        me = { role: 'citizen', word: r.foolWord, fool: true };
      } else {
        me = { role: isLiar ? 'liar' : 'citizen', word: isLiar ? null : r.word };
      }
    }
    return {
      t: 'state',
      now: Date.now(),
      code: this.code,
      hostId: this.hostId,
      you: p.id,
      phase: this.phase,
      roundNo: this.roundNo,
      settings: this.settings,
      categories: Object.entries(CATEGORIES).map(([key, c]) => ({ key, name: c.name })),
      players: [...this.players.values()].map((q) => ({
        id: q.id,
        name: q.name,
        connected: q.connected,
        score: q.score,
        isHost: q.id === this.hostId,
        participating: r ? r.participants.includes(q.id) : false,
        ready: r ? r.ready.has(q.id) : false,
        voted: r ? Boolean(r.votes[q.id]) : false,
        calledVote: r ? r.voteCalls.has(q.id) : false,
      })),
      round: r ? {
        no: r.no,
        category: r.catName,
        order: r.order,
        turnId: this.phase === 'hint' ? r.order[r.turnIdx] : null,
        hintRound: r.hintRound,
        hintRounds: this.settings.hintRounds,
        hints: r.hints,
        voteCandidates: r.revoteCandidates,
        revoted: r.revoted,
        lastTally: (this.phase === 'guess' || result || r.revoteCandidates) ? r.lastTally : null,
        voteCallCount: r.voteCalls.size,
        accused: r.accused,
        guessOptions: this.phase === 'guess' && r.accused === p.id ? r.guessOptions : null,
        guess: result ? r.guess : null,
        word: result ? r.word : null,
        foolWord: result ? r.foolWord : null,
        liars: result ? r.liars : null,
        outcome: r.outcome,
        reason: r.reason,
        deltas: result ? r.deltas : null,
      } : null,
      me,
      timer: this.timerInfo,
      chat: this.chat,
    };
  }

  broadcast() {
    for (const p of this.players.values()) if (p.connected) sendTo(p.ws, this.stateFor(p));
  }
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.room = null;
  ws.player = null;
  ws.isAlive = true;
  ws.lastChat = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    try {
      handle(ws, m);
    } catch (e) {
      console.error(e);
      sendTo(ws, { t: 'error', msg: '서버에서 오류가 났어요.' });
    }
  });
  ws.on('close', () => {
    if (ws.room && ws.player) ws.room.onDisconnect(ws.player, ws);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function joinRoom(ws, room, name, token) {
  const existing = token ? room.findByToken(token) : null;
  let p;
  if (existing) {
    room.rebind(existing, ws, name);
    p = existing;
  } else {
    if (room.players.size >= MAX_PLAYERS) return sendTo(ws, { t: 'error', msg: `방이 꽉 찼어요. (최대 ${MAX_PLAYERS}명)` });
    p = room.addPlayer(name, token || crypto.randomUUID(), ws);
    if (room.phase !== 'lobby') room.say(`${p.name}님은 다음 라운드부터 참여해요.`);
  }
  ws.room = room;
  ws.player = p;
  sendTo(ws, { t: 'joined', you: p.id, code: room.code, name: p.name });
  room.broadcast();
}

function handle(ws, m) {
  if (m.t === 'create') {
    const name = cleanName(m.name);
    if (!name) return sendTo(ws, { t: 'error', msg: '닉네임을 입력하세요.' });
    const room = new Room(genCode());
    rooms.set(room.code, room);
    return joinRoom(ws, room, name, typeof m.token === 'string' ? m.token.slice(0, 64) : null);
  }
  if (m.t === 'join') {
    const name = cleanName(m.name);
    const code = String(m.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return sendTo(ws, { t: 'error', msg: '방을 찾을 수 없어요. 코드를 확인하세요.', code: 'no_room' });
    const token = typeof m.token === 'string' ? m.token.slice(0, 64) : null;
    if (!name && !(token && room.findByToken(token))) return sendTo(ws, { t: 'error', msg: '닉네임을 입력하세요.' });
    return joinRoom(ws, room, name, token);
  }

  const room = ws.room;
  const p = ws.player;
  if (!room || !p) return sendTo(ws, { t: 'error', msg: '먼저 방에 들어가세요.' });
  const isHost = room.hostId === p.id;

  switch (m.t) {
    case 'chat': {
      const text = cleanText(m.text, 200);
      const now = Date.now();
      if (!text || now - ws.lastChat < 300) return;
      ws.lastChat = now;
      room.pushChat({ id: p.id, name: p.name, text, ts: now });
      return;
    }
    case 'leave': {
      ws.room = null;
      ws.player = null;
      p.ws = null;
      p.connected = false;
      room.removePlayer(p, '나갔어요');
      sendTo(ws, { t: 'left' });
      return;
    }
    case 'settings':
      if (isHost) room.updateSettings(m.settings);
      return;
    case 'start': {
      if (!isHost) return;
      const err = room.startGame();
      if (err) sendTo(ws, { t: 'error', msg: err });
      return;
    }
    case 'ready':
      return room.ready(p);
    case 'hint':
      return room.submitHint(p, m.text);
    case 'callVote':
      return room.callVote(p);
    case 'vote':
      return room.vote(p, String(m.target || ''));
    case 'guess':
      return room.guess(p, String(m.word || ''));
    case 'skip':
      if (isHost) room.hostSkip();
      return;
    case 'next':
      if (isHost) room.nextRound();
      return;
    case 'lobby':
      if (isHost) room.toLobby();
      return;
    case 'kick': {
      if (!isHost || room.phase !== 'lobby') return;
      const target = room.players.get(String(m.id || ''));
      if (!target || target.id === p.id) return;
      const tws = target.ws;
      target.ws = null;
      target.connected = false;
      room.removePlayer(target, '내보내졌어요');
      if (tws) {
        tws.room = null;
        tws.player = null;
        sendTo(tws, { t: 'kicked' });
      }
      return;
    }
    default:
      return;
  }
}

server.listen(PORT, () => {
  console.log(`라이어 게임 서버 실행 중: http://localhost:${PORT}`);
});
