'use strict';
// 자동으로 플레이하는 봇. 혼자 테스트할 때 사용.
// node test/bots.js <방코드> [봇 수=2] [포트=3000]
const WebSocket = require('ws');

const [code, countArg, portArg] = process.argv.slice(2);
if (!code) { console.error('사용법: node test/bots.js <방코드> [봇 수] [포트]'); process.exit(1); }
const count = Number(countArg || 2);
const port = Number(portArg || 3000);
const NAMES = ['봇민수', '봇지영', '봇철수', '봇영희', '봇준호', '봇하늘', '봇도윤', '봇서연'];
const HINTS = ['음… 그거 있잖아', '자주 보는 거', '내가 좋아하는 편', '설명하기 어렵네', '어릴 때 생각남', '색깔이 있음'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

for (let i = 0; i < count; i++) {
  const name = NAMES[i % NAMES.length];
  const ws = new WebSocket(`ws://localhost:${port}`);
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  let me = null;
  let acted = new Set();
  ws.on('open', () => send({ t: 'join', code: code.toUpperCase(), name, token: `bot-${name}` }));
  ws.on('message', async (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'joined') { me = m.you; console.log(`${name} 입장`); }
    if (m.t === 'error') console.log(`${name}:`, m.msg);
    if (m.t !== 'state') return;
    const key = `${m.roundNo}-${m.phase}-${m.round && m.round.hintRound}`;
    if (m.phase === 'reveal' && m.me && !acted.has(key)) { acted.add(key); await wait(1500); send({ t: 'ready' }); }
    if (m.phase === 'hint' && m.round.turnId === me && !acted.has(key)) { acted.add(key); await wait(2500); send({ t: 'hint', text: pick(HINTS) }); }
    if (m.phase === 'vote' && m.me && !acted.has(key + (m.round.voteCandidates ? 'r' : ''))) {
      acted.add(key + (m.round.voteCandidates ? 'r' : ''));
      await wait(2000);
      const cands = (m.round.voteCandidates || m.round.order).filter((id) => id !== me);
      if (cands.length) send({ t: 'vote', target: pick(cands) });
    }
    if (m.phase === 'guess' && m.round.guessOptions && !acted.has(key)) { acted.add(key); await wait(3000); send({ t: 'guess', word: pick(m.round.guessOptions) }); }
    if (m.phase === 'discuss' && m.me && !acted.has(key)) { acted.add(key); await wait(8000); send({ t: 'chat', text: pick(['누가 이상해?', '설명 좀 구체적으로 해봐', '나 아님 ㅋㅋ']) }); }
  });
  ws.on('close', () => console.log(`${name} 연결 종료`));
}
