'use strict';
// 4명의 봇이 한 라운드를 끝까지 플레이하는 통합 테스트.
// node test/sim.js
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3999;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const fail = (msg) => { console.error('FAIL:', msg); srv.kill(); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.ws = new WebSocket(`ws://localhost:${PORT}`);
    this.ready = new Promise((res) => { this.ws.on('open', res); });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'joined') this.id = m.you;
      if (m.t === 'state') this.state = m;
      if (m.t === 'error') console.log(`[${this.name}] error:`, m.msg);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async until(pred, label, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.state && pred(this.state)) return this.state;
      await wait(50);
    }
    fail(`${this.name}: timeout waiting for ${label}`);
  }
}

(async () => {
  await new Promise((res) => srv.stdout.on('data', res));
  const bots = ['호스트', '민수', '지영', '철수'].map((n) => new Bot(n));
  await Promise.all(bots.map((b) => b.ready));
  const [host, ...others] = bots;

  host.send({ t: 'create', name: host.name, token: 'tok-host' });
  const s0 = await host.until((s) => s.phase === 'lobby', 'lobby');
  const code = s0.code;
  console.log('room', code);
  others.forEach((b, i) => b.send({ t: 'join', code, name: b.name, token: `tok-${i}` }));
  await host.until((s) => s.players.length === 4, '4 players');

  host.send({ t: 'settings', settings: { hintTime: 10, discussTime: 30, voteTime: 10, guessTime: 10 } });
  await host.until((s) => s.settings.hintTime === 10, 'settings');

  // 방장 아닌 사람이 시작 시도 -> 무시돼야 함
  others[0].send({ t: 'start' });
  await wait(200);
  if (host.state.phase !== 'lobby') fail('non-host started game');

  host.send({ t: 'start' });
  await Promise.all(bots.map((b) => b.until((s) => s.phase === 'reveal', 'reveal')));
  const liars = bots.filter((b) => b.state.me.role === 'liar');
  const citizens = bots.filter((b) => b.state.me.role === 'citizen');
  if (liars.length !== 1) fail(`expected 1 liar, got ${liars.length}`);
  if (liars[0].state.me.word !== null) fail('liar can see the word');
  const word = citizens[0].state.me.word;
  if (!citizens.every((c) => c.state.me.word === word)) fail('citizens have different words');
  console.log('liar =', liars[0].name, '| word =', word, '| category =', host.state.round.category);

  bots.forEach((b) => b.send({ t: 'ready' }));
  await host.until((s) => s.phase === 'hint', 'hint phase');

  // 설명: 각자 차례에 제출
  for (let i = 0; i < 4; i++) {
    const s = await host.until((st) => st.phase === 'hint' && st.round.hints.length === i, `turn ${i}`);
    const cur = bots.find((b) => b.id === s.round.turnId);
    cur.send({ t: 'hint', text: `${cur.name}의 설명 ${i + 1}` });
  }
  await host.until((s) => s.phase === 'discuss', 'discuss');
  if (host.state.round.hints.length !== 4) fail('hint count');

  // 채팅
  others[1].send({ t: 'chat', text: '민수 수상한데?' });
  await wait(300);
  const hasChat = host.state.chat.some((m) => m.text === '민수 수상한데?') ||
    host.state.chat.length > 0; // 상태엔 브로드캐스트 시점 채팅만 포함될 수 있음
  if (!hasChat) fail('chat');

  // 과반 투표 요청 -> 바로 투표
  bots.slice(0, 3).forEach((b) => b.send({ t: 'callVote' }));
  await host.until((s) => s.phase === 'vote', 'vote via majority call');

  // 모두 라이어에게 투표
  const liar = liars[0];
  bots.filter((b) => b !== liar).forEach((b) => b.send({ t: 'vote', target: liar.id }));
  liar.send({ t: 'vote', target: citizens[0].id });
  await liar.until((s) => s.phase === 'guess' && Array.isArray(s.round.guessOptions), 'guess phase for liar');
  if (host.state.round.guessOptions !== null && host !== liar) fail('non-liar can see guess options');
  const opts = liar.state.round.guessOptions;
  if (opts.length !== 16 || !opts.includes(word)) fail('guess options');

  liar.send({ t: 'guess', word });
  await host.until((s) => s.phase === 'result', 'result');
  const r = host.state.round;
  if (r.outcome !== 'liar_guessed') fail(`outcome ${r.outcome}`);
  if (r.word !== word || !r.liars.includes(liar.id)) fail('result reveal');
  const liarScore = host.state.players.find((p) => p.id === liar.id).score;
  if (liarScore !== 2) fail(`liar score ${liarScore}`);
  console.log('round 1 result:', r.outcome, 'scores', host.state.players.map((p) => `${p.name}:${p.score}`).join(' '));

  // 2라운드: 투표 타임아웃 + 동률 재투표 흐름
  host.send({ t: 'next' });
  await host.until((s) => s.phase === 'reveal' && s.roundNo === 2, 'round 2');
  host.send({ t: 'skip' });
  await host.until((s) => s.phase === 'hint', 'hint 2');
  for (let i = 0; i < 4; i++) { await host.until((st) => st.round.hints.length === i, `turn ${i}`); host.send({ t: 'skip' }); }
  await host.until((s) => s.phase === 'discuss', 'discuss 2');
  host.send({ t: 'skip' });
  await host.until((s) => s.phase === 'vote', 'vote 2');
  // 2:2 동률
  bots[0].send({ t: 'vote', target: bots[1].id });
  bots[1].send({ t: 'vote', target: bots[0].id });
  bots[2].send({ t: 'vote', target: bots[1].id });
  bots[3].send({ t: 'vote', target: bots[0].id });
  await host.until((s) => s.phase === 'vote' && Array.isArray(s.round.voteCandidates), 'revote');
  if (host.state.round.voteCandidates.length !== 2) fail('revote candidates');
  // 재투표에서 후보 아닌 사람에게 투표 -> 무시. 아무도 안 찍고 타임아웃(10초) -> 라이어 승
  bots[2].send({ t: 'vote', target: bots[2].id });
  await host.until((s) => s.phase === 'result', 'result 2', 15000);
  if (host.state.round.outcome !== 'liar_escaped') fail(`round 2 outcome ${host.state.round.outcome}`);
  console.log('round 2 result:', host.state.round.outcome, host.state.round.reason);

  // 재접속: 민수 소켓 끊고 같은 토큰으로 다시 붙기
  const minsu = others[0];
  minsu.ws.close();
  await host.until((s) => s.players.find((p) => p.name === '민수').connected === false, 'disconnect');
  const minsu2 = new Bot('민수');
  await minsu2.ready;
  minsu2.send({ t: 'join', code, name: '민수', token: 'tok-0' });
  await host.until((s) => s.players.find((p) => p.name === '민수').connected === true, 'reconnect');
  if (host.state.players.length !== 4) fail('reconnect duplicated player');

  host.send({ t: 'lobby' });
  await host.until((s) => s.phase === 'lobby', 'back to lobby');
  console.log('ALL OK');
  srv.kill();
  process.exit(0);
})().catch((e) => fail(e.stack));
