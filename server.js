'use strict';

// 중앙 서버 모드. GitHub Pages(P2P)와 달리 방장이 나가도 방이 유지된다.
// 실행: npm start  →  http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Engine = require('./public/engine.js');

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

const rooms = new Map();          // code -> Room
const connections = new Map();    // connId -> ws
let connSeq = 0;

// 브라우저가 P2P 대신 이 서버의 WebSocket을 쓰도록 index.html에 표시
function serveIndex(res) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(html.replace('window.LIAR_MODE = "p2p"', 'window.LIAR_MODE = "server"'));
  });
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '/index.html') return serveIndex(res);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) return serveIndex(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// 엔진이 쓰는 전송 어댑터
const io = {
  send(connId, obj) {
    const ws = connections.get(connId);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  },
  kick(connId) {
    const ws = connections.get(connId);
    if (ws) {
      ws.roomRef = null;
      try { ws.close(); } catch (e) { /* ignore */ }
    }
  },
};

function newRoom() {
  let code;
  do { code = Engine.genCode(); } while (rooms.has(code));
  const room = new Engine.Room(code, io);
  room.onEmpty = () => rooms.delete(code);
  rooms.set(code, room);
  return room;
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.connId = `c${++connSeq}`;
  ws.roomRef = null;
  ws.isAlive = true;
  connections.set(ws.connId, ws);
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    try {
      // 방 배정은 서버가, 그 뒤 모든 진행은 엔진이 처리한다.
      if (m.t === 'create') {
        if (!Engine.cleanName(m.name)) return io.send(ws.connId, { t: 'error', msg: '닉네임을 입력하세요.' });
        const room = newRoom();
        ws.roomRef = room;
        return room.joinPlayer(ws.connId, m.name, m.token);
      }
      if (m.t === 'join' && m.code) {
        const room = rooms.get(String(m.code).trim().toUpperCase());
        if (!room) return io.send(ws.connId, { t: 'error', msg: '방을 찾을 수 없어요. 코드를 확인하세요.', code: 'no_room' });
        ws.roomRef = room;
        return room.joinPlayer(ws.connId, m.name, m.token);
      }
      if (!ws.roomRef) return io.send(ws.connId, { t: 'error', msg: '먼저 방에 들어가세요.', code: 'no_room' });
      ws.roomRef.handle(ws.connId, m);
    } catch (e) {
      console.error(e);
      io.send(ws.connId, { t: 'error', msg: '서버에서 오류가 났어요.' });
    }
  });

  ws.on('close', () => {
    connections.delete(ws.connId);
    if (ws.roomRef) ws.roomRef.onDisconnect(ws.connId);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`라이어 게임 서버 실행 중: http://localhost:${PORT}`);
});
