'use strict';
// 4명의 봇이 서버 모드로 여러 라운드를 끝까지 플레이하는 통합 테스트.
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
    this.chats = [];   // chat 메시지는 state 브로드캐스트에 실리지 않으므로 따로 모은다
    this.ws = new WebSocket(`ws://localhost:${PORT}`);
    this.ready = new Promise((res) => { this.ws.on('open', res); });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'joined') this.id = m.you;
      if (m.t === 'state') this.state = m;
      if (m.t === 'chat') this.chats.push(m.msg);
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

  const liarOf = () => bots.find((b) => b.state.me && b.state.me.role === 'liar');
  const secretWord = () => bots.find((b) => b.state.me && b.state.me.role === 'citizen').state.me.word;
  const scoreOf = (b) => host.state.players.find((p) => p.id === b.id).score;

  // 설명 단계를 방장 권한으로 전부 넘긴다.
  async function skipHints(label) {
    await host.until((s) => s.phase === 'hint', `hint ${label}`);
    for (let i = 0; i < bots.length; i++) {
      await host.until((st) => st.phase !== 'hint' || st.round.hints.length === i, `turn ${i} ${label}`);
      if (host.state.phase !== 'hint') break;
      host.send({ t: 'skip' });
    }
    await host.until((s) => s.phase === 'discuss', `discuss ${label}`);
  }

  host.send({ t: 'create', name: host.name, token: 'tok-host' });
  const s0 = await host.until((s) => s.phase === 'lobby', 'lobby');
  const code = s0.code;
  console.log('room', code);
  others.forEach((b, i) => b.send({ t: 'join', code, name: b.name, token: `tok-${i}` }));
  await host.until((s) => s.players.length === 4, '4 players');

  host.send({ t: 'settings', settings: { hintTime: 10, discussTime: 30, voteTime: 10, guessTime: 10 } });
  await host.until((s) => s.settings.hintTime === 10, 'settings');
  if (host.state.settings.liarGuess !== 'always') fail('liarGuess should default to always');

  // 방장 아닌 사람이 시작 시도 -> 무시돼야 함
  others[0].send({ t: 'start' });
  await wait(200);
  if (host.state.phase !== 'lobby') fail('non-host started game');

  // ── 1라운드: 라이어를 잡고, 라이어가 정답을 맞혀 역전승 ──────────────
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

  for (let i = 0; i < 4; i++) {
    const s = await host.until((st) => st.phase === 'hint' && st.round.hints.length === i, `turn ${i}`);
    const cur = bots.find((b) => b.id === s.round.turnId);
    cur.send({ t: 'hint', text: `${cur.name}의 설명 ${i + 1}` });
  }
  await host.until((s) => s.phase === 'discuss', 'discuss');
  if (host.state.round.hints.length !== 4) fail('hint count');

  others[1].send({ t: 'chat', text: '민수 수상한데?' });
  await wait(400);
  const said = host.chats.filter((m) => m.text === '민수 수상한데?');
  if (said.length !== 1) fail(`chat delivered ${said.length} times, expected 1`);
  if (host.state.chat.length !== new Set(host.state.chat.map((m) => m.text + m.ts)).size) fail('chat duplicated in state');

  bots.slice(0, 3).forEach((b) => b.send({ t: 'callVote' }));
  await host.until((s) => s.phase === 'vote', 'vote via majority call');

  const liar = liars[0];
  bots.filter((b) => b !== liar).forEach((b) => b.send({ t: 'vote', target: liar.id }));
  liar.send({ t: 'vote', target: citizens[0].id });
  await liar.until((s) => s.phase === 'guess' && Array.isArray(s.round.guessOptions), 'guess phase for liar');
  if (host !== liar && host.state.round.guessOptions !== null) fail('non-liar can see guess options');
  if (host.state.round.caught !== true) fail('round 1 should be caught');
  if (host.state.round.guesser !== liar.id) fail('guesser should be the caught liar');
  const opts = liar.state.round.guessOptions;
  if (opts.length !== 16 || !opts.includes(word)) fail('guess options');

  liar.send({ t: 'guess', word });
  await host.until((s) => s.phase === 'result', 'result');
  let r = host.state.round;
  if (r.outcome !== 'liar_guessed' || r.reason !== 'guess') fail(`round 1 ${r.outcome}/${r.reason}`);
  if (r.word !== word || !r.liars.includes(liar.id)) fail('result reveal');
  if (scoreOf(liar) !== 2) fail(`liar score ${scoreOf(liar)}`);
  console.log('round 1:', r.outcome, '| scores', host.state.players.map((p) => `${p.name}:${p.score}`).join(' '));

  // ── 2라운드: 동률 재투표로 아무도 못 잡음 -> 그래도 라이어가 정답을 맞혀야 함 (틀림) ──
  host.send({ t: 'next' });
  await host.until((s) => s.phase === 'reveal' && s.roundNo === 2, 'round 2');
  host.send({ t: 'skip' });
  await skipHints('2');
  host.send({ t: 'skip' });
  await host.until((s) => s.phase === 'vote', 'vote 2');
  bots[0].send({ t: 'vote', target: bots[1].id });
  bots[1].send({ t: 'vote', target: bots[0].id });
  bots[2].send({ t: 'vote', target: bots[1].id });
  bots[3].send({ t: 'vote', target: bots[0].id });
  await host.until((s) => s.phase === 'vote' && Array.isArray(s.round.voteCandidates), 'revote');
  if (host.state.round.voteCandidates.length !== 2) fail('revote candidates');
  bots[2].send({ t: 'vote', target: bots[2].id }); // 후보가 아니므로 무시돼야 함

  const liar2 = liarOf();
  const secret2 = secretWord();
  const before2 = bots.map((b) => scoreOf(b));
  // 재투표 타임아웃 -> 못 잡았지만 always 모드라 정답 기회로 넘어간다
  await liar2.until((s) => s.phase === 'guess', 'guess 2 (uncaught)', 15000);
  if (host.state.round.caught !== false) fail('round 2 should be uncaught');
  if (host.state.round.guesser !== liar2.id) fail('uncaught liar should be the guesser');
  if (!Array.isArray(liar2.state.round.guessOptions)) fail('uncaught liar needs guess options');
  const wrongWord = liar2.state.round.guessOptions.find((w) => w !== secret2);
  liar2.send({ t: 'guess', word: wrongWord });
  await host.until((s) => s.phase === 'result', 'result 2');
  r = host.state.round;
  if (r.outcome !== 'citizens_win' || r.reason !== 'escaped_wrong') fail(`round 2 ${r.outcome}/${r.reason}`);
  bots.forEach((b, i) => {
    const gained = scoreOf(b) - before2[i];
    const expect = b === liar2 ? 0 : 1;
    if (gained !== expect) fail(`round 2 score for ${b.name}: +${gained}, expected +${expect}`);
  });
  console.log('round 2:', r.outcome, r.reason, '| 라이어가 못 맞혀서 시민 승리');

  // ── 3라운드: 엉뚱한 사람을 지목 -> 라이어가 정답까지 맞혀 완승 ──────────
  host.send({ t: 'next' });
  await host.until((s) => s.phase === 'reveal' && s.roundNo === 3, 'round 3');
  host.send({ t: 'skip' });
  await skipHints('3');
  host.send({ t: 'skip' });
  await host.until((s) => s.phase === 'vote', 'vote 3');
  const liar3 = liarOf();
  const secret3 = secretWord();
  const scapegoat = bots.find((b) => b !== liar3);
  const before3 = scoreOf(liar3);
  bots.filter((b) => b !== scapegoat).forEach((b) => b.send({ t: 'vote', target: scapegoat.id }));
  scapegoat.send({ t: 'vote', target: bots.find((b) => b !== scapegoat).id });
  await liar3.until((s) => s.phase === 'guess', 'guess 3 (wrong pick)');
  if (host.state.round.caught !== false) fail('round 3 should be uncaught');
  liar3.send({ t: 'guess', word: secret3 });
  await host.until((s) => s.phase === 'result', 'result 3');
  r = host.state.round;
  if (r.outcome !== 'liar_escaped' || r.reason !== 'escaped_guess') fail(`round 3 ${r.outcome}/${r.reason}`);
  if (scoreOf(liar3) - before3 !== 3) fail(`round 3 liar gained ${scoreOf(liar3) - before3}, expected +3`);
  console.log('round 3:', r.outcome, r.reason, '| 안 잡히고 정답까지 맞혀 +3');

  // ── caught 모드: 못 잡으면 정답 기회 없이 바로 라이어 승 (기존 규칙 보존) ──
  host.send({ t: 'lobby' });
  await host.until((s) => s.phase === 'lobby', 'back to lobby');
  host.send({ t: 'settings', settings: { liarGuess: 'caught' } });
  await host.until((s) => s.settings.liarGuess === 'caught', 'caught mode');
  host.send({ t: 'start' });
  await host.until((s) => s.phase === 'reveal', 'reveal caught-mode');
  host.send({ t: 'skip' });
  await skipHints('caught');
  host.send({ t: 'skip' });
  await host.until((s) => s.phase === 'vote', 'vote caught-mode');
  const liar4 = liarOf();
  const scapegoat4 = bots.find((b) => b !== liar4);
  bots.filter((b) => b !== scapegoat4).forEach((b) => b.send({ t: 'vote', target: scapegoat4.id }));
  scapegoat4.send({ t: 'vote', target: bots.find((b) => b !== scapegoat4).id });
  await host.until((s) => s.phase === 'result', 'result caught-mode');
  r = host.state.round;
  if (r.outcome !== 'liar_escaped' || r.reason !== 'wrong_pick') fail(`caught mode ${r.outcome}/${r.reason}`);
  if (r.guesser !== null) fail('caught mode should not give an uncaught liar a guess');
  console.log('caught 모드:', r.outcome, r.reason, '| 정답 단계 없이 종료');

  // ── 재접속: 민수 소켓을 끊고 같은 토큰으로 다시 붙기 ──────────────────
  const minsu = others[0];
  const minsuScore = scoreOf(minsu);
  minsu.ws.close();
  await host.until((s) => s.players.find((p) => p.name === '민수').connected === false, 'disconnect');
  const minsu2 = new Bot('민수');
  await minsu2.ready;
  minsu2.send({ t: 'join', code, name: '민수', token: 'tok-0' });
  await host.until((s) => s.players.find((p) => p.name === '민수').connected === true, 'reconnect');
  if (host.state.players.length !== 4) fail('reconnect duplicated player');
  if (host.state.players.find((p) => p.name === '민수').score !== minsuScore) fail('score lost on reconnect');

  console.log('ALL OK');
  srv.kill();
  process.exit(0);
})().catch((e) => fail(e.stack));
