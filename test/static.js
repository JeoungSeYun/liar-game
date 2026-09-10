'use strict';
// GitHub Pages 환경 재현용 정적 서버 (모드 주입 없음 = P2P).
// node test/static.js [포트=3100]
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 3100);
const DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(DIR, p));
  if (!file.startsWith(DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`정적 서버 (P2P 모드): http://localhost:${PORT}`));
