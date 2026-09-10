'use strict';
// 게임 규칙 엔진. 전송 방식과 무관하다.
// 브라우저(방장이 호스팅)와 Node 서버 양쪽에서 같은 코드를 쓴다.
//
// 전송 계층은 io 객체 하나만 넘기면 된다:
//   io.send(connId, obj)  해당 연결로 메시지 전송
//   io.kick(connId)       해당 연결 끊기
(function (global) {
  const isNode = typeof module === 'object' && module.exports;
  const CATEGORIES = isNode ? require('./words.js').CATEGORIES : global.LIAR_CATEGORIES;

  const MAX_PLAYERS = 12;
  const MIN_PLAYERS = 3;
  const REVEAL_MS = 25000;
  const DEFAULT_SETTINGS = {
    category: 'random',
    liarCount: 1,
    fool: false,
    // always: 투표 결과와 상관없이 라이어가 마지막에 제시어를 맞혀야 이긴다.
    // caught: 지목당했을 때만 정답 기회를 준다.
    liarGuess: 'always',
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
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

  function randHex(bytes) {
    const a = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const shortId = () => randHex(4);
  const newToken = () => randHex(16);

  function genCode() {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return code;
  }

  class Room {
    constructor(code, io) {
      this.code = code;
      this.io = io;
      this.onEmpty = null;
      this.hostId = null;
      this.players = new Map(); // playerId -> player
      this.settings = { ...DEFAULT_SETTINGS };
      this.phase = 'lobby';
      this.round = null;
      this.roundNo = 0;
      this.chat = [];
      this.timer = null;
      this.timerInfo = null;
      this.usedWords = new Set();
      this.emptySince = null;
      this.closed = false;
    }

    send(connId, obj) {
      if (connId) this.io.send(connId, obj);
    }

    // ----- 입장 -----
    joinPlayer(connId, rawName, rawToken) {
      const name = cleanName(rawName);
      const token = typeof rawToken === 'string' && rawToken ? rawToken.slice(0, 64) : null;
      const existing = token ? this.findByToken(token) : null;
      let p;
      if (existing) {
        this.rebind(existing, connId, name);
        p = existing;
      } else {
        if (!name) {
          this.send(connId, { t: 'error', msg: '닉네임을 입력하세요.' });
          return null;
        }
        if (this.players.size >= MAX_PLAYERS) {
          this.send(connId, { t: 'error', msg: `방이 꽉 찼어요. (최대 ${MAX_PLAYERS}명)`, code: 'full' });
          return null;
        }
        p = this.addPlayer(name, token || newToken(), connId);
        if (this.phase !== 'lobby') this.say(`${p.name}님은 다음 라운드부터 참여해요.`);
      }
      this.send(connId, { t: 'joined', you: p.id, code: this.code, name: p.name, token: p.token });
      this.broadcast();
      return p;
    }

    addPlayer(name, token, connId) {
      const p = { id: shortId(), token, name, connId, connected: true, score: 0, lastChat: 0, joinedAt: Date.now() };
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

    findByConn(connId) {
      for (const p of this.players.values()) if (p.connId === connId) return p;
      return null;
    }

    rebind(p, connId, name) {
      if (p.connId && p.connId !== connId) this.io.kick(p.connId);
      p.connId = connId;
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
        this.round.participants = this.round.participants.filter((id) => id !== p.id);
        this.afterPlayerGone();
      }
      if (this.players.size === 0) {
        this.clearTimer();
        this.closed = true;
        if (this.onEmpty) this.onEmpty();
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

    onDisconnect(connId) {
      const p = this.findByConn(connId);
      if (!p) return;
      p.connId = null;
      p.connected = false;
      this.say(`${p.name}님의 연결이 끊겼어요.`);

      if (this.phase === 'lobby') {
        setTimeout(() => {
          if (!this.closed && !p.connected && this.players.get(p.id) === p) this.removePlayer(p, '나갔어요');
        }, 15000);
      }
      if (this.hostId === p.id) {
        setTimeout(() => {
          if (!this.closed && !p.connected && this.hostId === p.id && this.players.size > 1) {
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
            this.closed = true;
            if (this.onEmpty) this.onEmpty();
          }
        }, 10 * 60 * 1000);
      }
      this.afterPlayerGone();
      this.broadcast();
    }

    // 나가거나 끊긴 사람 때문에 진행이 멈추지 않도록 정리
    afterPlayerGone() {
      const r = this.round;
      if (!r) return;
      if (this.phase === 'reveal') this.checkAllReady();
      else if (this.phase === 'hint' && !this.players.get(r.order[r.turnIdx])?.connected) this.passTurn(r.order[r.turnIdx]);
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
      for (const p of this.players.values()) this.send(p.connId, { t: 'chat', msg });
    }

    // ----- 타이머 -----
    setTimer(ms, fn) {
      this.clearTimer();
      this.timerInfo = { endsAt: Date.now() + ms, total: ms };
      this.timer = setTimeout(() => {
        this.timer = null;
        this.timerInfo = null;
        if (!this.closed) fn();
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
      if (s.liarGuess === 'always' || s.liarGuess === 'caught') out.liarGuess = s.liarGuess;
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
      const catKey = this.settings.category === 'random' ? pick(Object.keys(CATEGORIES)) : this.settings.category;
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
      const liars = shuffle(active).slice(0, liarCount);

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
        caught: false,
        guesser: null,
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
      if (!r) return;
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
        return this.afterVote(null, 'no_vote');
      }
      const top = entries[0][1];
      const tied = entries.filter(([, n]) => n === top).map(([id]) => id);
      if (tied.length > 1) {
        if (!r.revoted) {
          r.revoted = true;
          return this.startVote(tied);
        }
        this.say('다시 투표해도 동률이라 아무도 지목하지 못했어요.');
        return this.afterVote(null, 'tie');
      }
      r.accused = tied[0];
      const accusedName = this.players.get(r.accused)?.name || '?';
      if (r.liars.includes(r.accused)) {
        this.say(`${accusedName}님이 지목됐어요. 정체는... 라이어!`);
        return this.afterVote(r.accused, 'caught');
      }
      this.say(`${accusedName}님이 지목됐어요. 하지만 라이어가 아니었어요!`);
      return this.afterVote(null, 'wrong_pick');
    }

    // 투표가 끝난 뒤 누가 제시어를 맞힐 차례인지 정한다.
    // always 모드에서는 라이어를 못 잡아도 라이어가 정답을 맞혀야 이긴다.
    afterVote(caughtLiarId, how) {
      const r = this.round;
      r.caught = Boolean(caughtLiarId);
      if (caughtLiarId) {
        r.guesser = caughtLiarId;
      } else if (this.settings.liarGuess === 'always') {
        r.guesser = r.liars.find((id) => this.players.get(id)?.connected) || r.liars[0] || null;
      } else {
        r.guesser = null;
      }
      if (!r.guesser) return this.finish('liar_escaped', how);
      const gName = this.players.get(r.guesser)?.name || '?';
      this.say(r.caught
        ? `마지막 기회! ${gName}님이 제시어를 맞히면 라이어가 이겨요.`
        : `라이어를 잡지 못했어요. 그래도 ${gName}님이 제시어를 맞혀야 라이어가 이겨요.`);
      return this.startGuess();
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
      if (this.phase !== 'guess' || !r || p.id !== r.guesser) return;
      if (!r.guessOptions.includes(word)) return;
      r.guess = word;
      if (word === r.word) {
        // 잡히고도 맞히면 역전승, 안 잡히고 맞히면 완승
        this.finish(r.caught ? 'liar_guessed' : 'liar_escaped', r.caught ? 'guess' : 'escaped_guess');
      } else {
        this.finish('citizens_win', r.caught ? 'wrong_guess' : 'escaped_wrong');
      }
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
        for (const id of r.liars) add(id, id === r.guesser ? SCORE.liarGuessed : SCORE.liarOtherOnGuess);
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

    // ----- 메시지 처리 -----
    handle(connId, m) {
      if (!m || typeof m !== 'object' || this.closed) return;
      if (m.t === 'join') return this.joinPlayer(connId, m.name, m.token);

      const p = this.findByConn(connId);
      if (!p) {
        this.send(connId, { t: 'error', msg: '먼저 방에 들어가세요.', code: 'no_player' });
        return;
      }
      const isHost = this.hostId === p.id;

      switch (m.t) {
        case 'chat': {
          const text = cleanText(m.text, 200);
          const now = Date.now();
          if (!text || now - p.lastChat < 300) return;
          p.lastChat = now;
          return this.pushChat({ id: p.id, name: p.name, text, ts: now });
        }
        case 'leave': {
          p.connId = null;
          p.connected = false;
          this.removePlayer(p, '나갔어요');
          this.send(connId, { t: 'left' });
          return;
        }
        case 'settings':
          if (isHost) this.updateSettings(m.settings);
          return;
        case 'start': {
          if (!isHost) return;
          const err = this.startGame();
          if (err) this.send(connId, { t: 'error', msg: err });
          return;
        }
        case 'ready':
          return this.ready(p);
        case 'hint':
          return this.submitHint(p, m.text);
        case 'callVote':
          return this.callVote(p);
        case 'vote':
          return this.vote(p, String(m.target || ''));
        case 'guess':
          return this.guess(p, String(m.word || ''));
        case 'skip':
          if (isHost) this.hostSkip();
          return;
        case 'next':
          if (isHost) this.nextRound();
          return;
        case 'lobby':
          if (isHost) this.toLobby();
          return;
        case 'kick': {
          if (!isHost || this.phase !== 'lobby') return;
          const target = this.players.get(String(m.id || ''));
          if (!target || target.id === p.id) return;
          const targetConn = target.connId;
          target.connId = null;
          target.connected = false;
          this.removePlayer(target, '내보내졌어요');
          if (targetConn) {
            this.send(targetConn, { t: 'kicked' });
            this.io.kick(targetConn);
          }
          return;
        }
        default:
          return;
      }
    }

    // ----- 상태 -----
    stateFor(p) {
      const r = this.round;
      const result = this.phase === 'result';
      let me = null;
      if (r && r.participants.includes(p.id)) {
        const isLiar = r.liars.includes(p.id);
        if (isLiar && this.settings.fool && !result && !(this.phase === 'guess' && r.guesser === p.id)) {
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
          caught: r.caught,
          guesser: r.guesser,
          guessOptions: this.phase === 'guess' && r.guesser === p.id ? r.guessOptions : null,
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
      if (this.closed) return;
      for (const p of this.players.values()) if (p.connected) this.send(p.connId, this.stateFor(p));
    }
  }

  const api = { Room, CATEGORIES, MAX_PLAYERS, MIN_PLAYERS, genCode, newToken, cleanName, cleanText };
  if (isNode) module.exports = api;
  else global.LiarEngine = api;
})(typeof self !== 'undefined' ? self : globalThis);
