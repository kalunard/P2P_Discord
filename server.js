const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ===== TURN REST API =====
// На Layero нет /run/secrets/, поэтому секрет берём только из env
function loadTurnSecret() {
  if (process.env.TURN_SECRET) {
    return process.env.TURN_SECRET.trim();
  }
  console.warn('TURN_SECRET не задан. TURN будет недоступен (только STUN).');
  return null;
}

const TURN_SECRET = loadTurnSecret();
const TURN_TTL = 3600;
const TURN_HOST = process.env.TURN_HOST || '192.168.50.90';

function generateTurnCredentials(userId = 'anonymous') {
  if (!TURN_SECRET) {
    return { username: null, credential: null, ttl: 0, uris: [] };
  }
  const timestamp = Math.floor(Date.now() / 1000) + TURN_TTL;
  const username = `${timestamp}:${userId}`;
  const credential = crypto
    .createHmac('sha1', TURN_SECRET)
    .update(username)
    .digest('base64');
  return {
    username,
    credential,
    ttl: TURN_TTL,
    uris: [
      `turn:${TURN_HOST}:3478?transport=udp`,
      `turn:${TURN_HOST}:3478?transport=tcp`,
    ],
  };
}

// ===== Security Headers =====
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    // Разрешаем ws/wss для Layero и localhost
    "connect-src 'self' wss://*.layero.app ws://localhost:3000 wss://localhost:3000",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function applySecurityHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
}

// ===== HTTP статика =====
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

// ALLOWED_ORIGINS объявляем ДО createServer
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // Layero-домены (можно указать конкретно, если знаешь slug)
  'https://*.layero.app',
];

const server = http.createServer((req, res) => {
  applySecurityHeaders(res);

  // TURN REST API
  if (req.url === '/turn-credentials') {
    const origin = req.headers.origin;
    // Для деплоя на Layero разрешаем все, т.к. домен неизвестен заранее
    // (или проверяй по своему slug)
    if (origin && !origin.includes('layero.app') && !origin.includes('localhost')) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    const creds = generateTurnCredentials(
      'user-' + Math.random().toString(36).slice(2, 8)
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(creds));
    return;
  }

  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';

  const fullPath = path.join(__dirname, filePath);
  if (!fullPath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ===== WebSocket сигнализация =====
const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  verifyClient: (info) => {
    const origin = info.origin;
    if (!origin) return true;
    // Разрешаем localhost и любой *.layero.app
    return origin.includes('localhost') || origin.includes('layero.app');
  },
});

const rooms = new Map();
const connectionsPerIP = new Map();
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_MESSAGE_SIZE = 64 * 1024;
const MESSAGE_LIMIT = 1000;

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcast(roomId, sender, type, payload) {
  const peers = rooms.get(roomId);
  if (!peers) return;
  for (const peer of peers) {
    if (peer !== sender) send(peer, type, payload);
  }
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || 'unknown';
  const count = connectionsPerIP.get(ip) || 0;
  if (count >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1008, 'Too many connections');
    return;
  }
  connectionsPerIP.set(ip, count + 1);

  ws.on('close', () => {
    const c = connectionsPerIP.get(ip) || 1;
    if (c <= 1) connectionsPerIP.delete(ip);
    else connectionsPerIP.set(ip, c - 1);
  });

  let currentRoom = null;
  let messageCount = 0;

  ws.on('message', (raw) => {
    messageCount++;
    if (messageCount > MESSAGE_LIMIT) {
      ws.close(1008, 'Too many messages');
      return;
    }
    if (raw.length > MAX_MESSAGE_SIZE) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type, payload } = msg;
    if (!type || !payload) return;

    if (type === 'join') {
      const roomId = payload.roomId;
      if (!roomId || typeof roomId !== 'string' || roomId.length > 20) return;
      if (!/^[a-z0-9]+$/.test(roomId)) return;

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const peers = rooms.get(roomId);

      if (peers.size >= 2) {
        send(ws, 'room-full', {});
        return;
      }

      const isInitiator = peers.size === 0;
      peers.add(ws);
      currentRoom = roomId;

      send(ws, 'joined', { roomId, isInitiator, peersCount: peers.size });
      broadcast(roomId, ws, 'peer-joined', {});
      return;
    }

    if (['offer', 'answer', 'ice-candidate'].includes(type)) {
      if (!currentRoom) return;
      broadcast(currentRoom, ws, type, payload);
      return;
    }

    if (type === 'leave') {
      handleLeave();
    }
  });

  ws.on('close', handleLeave);
  ws.on('error', handleLeave);

  function handleLeave() {
    if (!currentRoom) return;
    const peers = rooms.get(currentRoom);
    if (peers) {
      peers.delete(ws);
      broadcast(currentRoom, ws, 'peer-left', {});
      if (peers.size === 0) rooms.delete(currentRoom);
    }
    currentRoom = null;
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});