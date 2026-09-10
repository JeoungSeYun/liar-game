'use strict';
// 전송 계층. 두 가지 모드를 같은 인터페이스로 감싼다.
//
//  p2p    (기본, GitHub Pages 등 정적 호스팅)
//         방장 브라우저가 게임 엔진을 돌리고, 나머지는 WebRTC로 방장에게 붙는다.
//         서버가 필요 없다. 대신 방장이 탭을 닫으면 방이 사라진다.
//  server (server.js 가 서빙할 때)
//         WebSocket 으로 중앙 서버에 붙는다. 방장이 나가도 방이 유지된다.
(function (global) {
  const PEER_PREFIX = 'liargamekr-';
  const LOCAL = '@me';
  const RECONNECT_TRIES = 15;
  const RECONNECT_DELAY = 2000;

  const Net = {
    mode: global.LIAR_MODE === 'server' ? 'server' : 'p2p',
    role: null,        // 'host' | 'guest'
    code: null,
    onMessage: () => {},
    onStatus: () => {},
    connected: false,

    send() {},
    createRoom() {},
    joinRoom() {},
    leave() {},
    resume() {},
  };

  const emit = (obj) => { Net.onMessage(obj); };
  const status = (ok, text) => {
    Net.connected = ok;
    Net.onStatus(ok, text);
  };

  // ============================================================
  // 서버 모드 (WebSocket)
  // ============================================================
  function setupServerMode() {
    let ws = null;
    let pending = null;
    let manualClose = false;

    function open() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}`);
      ws.onopen = () => {
        status(true, '서버 연결됨');
        if (pending) { rawSend(pending); pending = null; }
        else if (Net.code) rawSend({ t: 'join', code: Net.code, name: Net.name || '', token: Net.token });
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.t === 'joined') { Net.code = m.code; Net.role = 'guest'; }
        if (m.t === 'left' || m.t === 'kicked') Net.code = null;
        emit(m);
      };
      ws.onclose = () => {
        status(false, '서버 연결 중…');
        if (!manualClose) setTimeout(open, 1500);
      };
      ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
    }

    function rawSend(obj) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
      else pending = obj;
    }

    Net.send = rawSend;
    Net.createRoom = (name, token) => {
      Net.name = name; Net.token = token;
      rawSend({ t: 'create', name, token });
    };
    Net.joinRoom = (code, name, token) => {
      Net.name = name; Net.token = token; Net.code = code;
      rawSend({ t: 'join', code, name, token });
    };
    Net.leave = () => { rawSend({ t: 'leave' }); Net.code = null; };
    Net.resume = (saved) => {
      Net.name = saved.name; Net.token = saved.token;
      if (saved.code) { Net.code = saved.code; rawSend({ t: 'join', code: saved.code, name: saved.name, token: saved.token }); }
    };
    manualClose = false;
    open();
  }

  // ============================================================
  // P2P 모드 (WebRTC / PeerJS)
  // ============================================================
  function setupP2pMode() {
    const Engine = global.LiarEngine;
    let peer = null;      // 내 PeerJS 인스턴스
    let room = null;      // 방장일 때만: 게임 엔진
    let conns = new Map();// 방장일 때만: connId -> DataConnection
    let hostConn = null;  // 참가자일 때만: 방장과의 연결
    let connSeq = 0;
    let retryTimer = null;
    let retries = 0;

    const peerOpts = { debug: 0 };

    function destroyPeer() {
      clearTimeout(retryTimer);
      retryTimer = null;
      if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } }
      peer = null;
      hostConn = null;
      conns = new Map();
      if (room) { room.closed = true; room.clearTimer(); }
      room = null;
    }

    function needPeerJs() {
      if (global.Peer) return true;
      status(false, 'P2P 라이브러리를 못 불러왔어요. 새로고침 해보세요.');
      emit({ t: 'error', msg: 'P2P 라이브러리 로드 실패. 광고 차단기를 끄고 새로고침 해보세요.' });
      return false;
    }

    // 방장 자신에게 보내는 메시지는 복제해서 넘긴다.
    // 참가자에게는 어차피 직렬화돼서 가므로, 복제하지 않으면 방장 화면만
    // 엔진 내부 객체(chat 배열 등)를 그대로 받아 UI가 엔진 상태를 건드리게 된다.
    const copy = (obj) => JSON.parse(JSON.stringify(obj));

    // ---------- 방장 ----------
    const io = {
      send(connId, obj) {
        if (connId === LOCAL) { const c = copy(obj); queueMicrotask(() => emit(c)); return; }
        const c = conns.get(connId);
        if (c && c.open) { try { c.send(obj); } catch (e) { /* ignore */ } }
      },
      kick(connId) {
        const c = conns.get(connId);
        if (c) { try { c.close(); } catch (e) { /* ignore */ } conns.delete(connId); }
      },
    };

    function startHost(code, name, token, attempt) {
      if (!needPeerJs()) return;
      destroyPeer();
      status(false, '방 만드는 중…');
      const wanted = code || Engine.genCode();
      peer = new global.Peer(PEER_PREFIX + wanted, peerOpts);

      peer.on('open', () => {
        Net.role = 'host';
        Net.code = wanted;
        Net.name = name;
        Net.token = token;
        room = new Engine.Room(wanted, io);
        room.onEmpty = () => { /* 방장 브라우저가 방 자체이므로 정리 불필요 */ };
        status(true, '방 열림 · 친구를 초대하세요');
        room.joinPlayer(LOCAL, name, token);
      });

      peer.on('connection', (conn) => {
        const connId = `c${++connSeq}`;
        conns.set(connId, conn);
        conn.on('data', (m) => { if (room) room.handle(connId, m); });
        conn.on('close', () => {
          conns.delete(connId);
          if (room) room.onDisconnect(connId);
        });
        conn.on('error', () => {
          conns.delete(connId);
          if (room) room.onDisconnect(connId);
        });
      });

      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          // 코드가 이미 쓰이는 중. 지정 코드면 잠깐 뒤 재시도, 아니면 새 코드로.
          if ((attempt || 0) < 5) {
            const nextCode = code && attempt < 2 ? code : null;
            setTimeout(() => startHost(nextCode, name, token, (attempt || 0) + 1), code ? 1200 : 0);
          } else {
            status(false, '방을 만들지 못했어요');
            emit({ t: 'error', msg: '방 코드를 확보하지 못했어요. 다시 시도해주세요.', code: 'no_room' });
          }
          return;
        }
        if (err.type === 'browser-incompatible') {
          emit({ t: 'error', msg: '이 브라우저는 WebRTC를 지원하지 않아요. 크롬이나 사파리를 써주세요.' });
          return;
        }
        status(false, '연결 문제 발생');
        emit({ t: 'error', msg: `연결 오류: ${err.type || err.message || '알 수 없음'}` });
      });

      peer.on('disconnected', () => {
        status(false, '중계 서버 재연결 중…');
        try { peer.reconnect(); } catch (e) { /* ignore */ }
      });
    }

    // ---------- 참가자 ----------
    function startGuest(code, name, token) {
      if (!needPeerJs()) return;
      destroyPeer();
      Net.role = 'guest';
      Net.code = code;
      Net.name = name;
      Net.token = token;
      retries = 0;
      status(false, '방에 접속 중…');
      peer = new global.Peer(peerOpts);
      peer.on('open', () => dial());
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') return scheduleRetry();
        if (err.type === 'browser-incompatible') {
          emit({ t: 'error', msg: '이 브라우저는 WebRTC를 지원하지 않아요. 크롬이나 사파리를 써주세요.' });
          return;
        }
        status(false, '연결 문제 발생');
        scheduleRetry();
      });
      peer.on('disconnected', () => {
        try { peer.reconnect(); } catch (e) { /* ignore */ }
      });
    }

    function dial() {
      if (!peer || peer.destroyed) return;
      const conn = peer.connect(PEER_PREFIX + Net.code, { reliable: true, serialization: 'json' });
      if (!conn) return scheduleRetry();
      hostConn = conn;
      conn.on('open', () => {
        retries = 0;
        status(true, '방장과 연결됨');
        conn.send({ t: 'join', name: Net.name, token: Net.token });
      });
      conn.on('data', (m) => {
        if (m && m.t === 'joined') Net.code = m.code;
        if (m && (m.t === 'left' || m.t === 'kicked')) { Net.code = null; destroyPeer(); }
        emit(m);
      });
      conn.on('close', () => { hostConn = null; scheduleRetry(); });
      conn.on('error', () => { hostConn = null; scheduleRetry(); });
    }

    function scheduleRetry() {
      if (Net.role !== 'guest' || !Net.code || retryTimer) return;
      if (retries >= RECONNECT_TRIES) {
        status(false, '방장과 연결이 끊겼어요');
        emit({ t: 'error', msg: '방장과 연결이 끊겼어요. 방장이 페이지를 닫았을 수 있어요.', code: 'no_room' });
        destroyPeer();
        return;
      }
      retries += 1;
      status(false, `방장 찾는 중… (${retries}/${RECONNECT_TRIES})`);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (peer && !peer.destroyed && peer.open) dial();
        else if (Net.code) startGuest(Net.code, Net.name, Net.token);
      }, RECONNECT_DELAY);
    }

    // ---------- 공개 API ----------
    Net.send = (obj) => {
      if (Net.role === 'host') {
        if (room) room.handle(LOCAL, copy(obj));
      } else if (hostConn && hostConn.open) {
        try { hostConn.send(obj); } catch (e) { /* ignore */ }
      }
    };
    Net.createRoom = (name, token) => startHost(null, name, token, 0);
    Net.joinRoom = (code, name, token) => startGuest(code, name, token);
    Net.leave = () => {
      if (Net.role === 'host' && room) {
        // 참가자들에게 방이 닫힌다고 알린 뒤 정리
        for (const [connId, c] of conns) { io.send(connId, { t: 'roomClosed' }); }
        setTimeout(destroyPeer, 200);
      } else {
        Net.send({ t: 'leave' });
        setTimeout(destroyPeer, 100);
      }
      Net.code = null;
      Net.role = null;
      status(false, '');
    };
    Net.resume = (saved) => {
      Net.name = saved.name;
      Net.token = saved.token;
      if (!saved.code) return;
      // 새로고침 복구: 방장이었으면 같은 코드를 다시 잡고, 참가자였으면 다시 붙는다.
      if (saved.role === 'host') startHost(saved.code, saved.name, saved.token, 0);
      else startGuest(saved.code, saved.name, saved.token);
    };

    status(false, '');
  }

  Net.init = () => {
    if (Net.mode === 'server') setupServerMode();
    else setupP2pMode();
  };

  global.Net = Net;
})(typeof self !== 'undefined' ? self : globalThis);
