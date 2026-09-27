const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// --- HTTP для статики ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
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

// --- WebSocket для сигнализации ---
const wss = new WebSocketServer({ server });
const rooms = new Map(); // Map<roomId, Set<ws>>

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

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { type, payload } = msg;

    if (type === 'join') {
      const roomId = payload.roomId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const peers = rooms.get(roomId);
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
  console.log(`Server: http://localhost:${PORT}`);
});