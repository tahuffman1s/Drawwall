const express = require('express');
const http    = require('http');
const https   = require('https');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── Canvas state ──────────────────────────────────────────────────────────────
const CANVAS_W = 1000;
const CANVAS_H = 1000;
const pixels   = {};

// ── User state ────────────────────────────────────────────────────────────────
const users = {};
const USER_COLORS = [
  '#e74c3c','#e67e22','#f1c40f','#2ecc71',
  '#1abc9c','#3498db','#9b59b6','#e91e63',
  '#ff5722','#00bcd4','#8bc34a','#ff9800',
];
function pickColor() {
  const used = new Set(Object.values(users).map(u => u.color));
  return USER_COLORS.find(c => !used.has(c)) ?? USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
}

// ── Chat / reaction state ─────────────────────────────────────────────────────
const chatStore    = {};  // msgId -> { id, userId, reactions: { emoji: Set<socketId> } }
let   msgSeq       = 0;
const MAX_MESSAGES = 200;

// ── Custom emojis ─────────────────────────────────────────────────────────────
const customEmojis = {};  // name -> dataUrl

// ── GIF search proxy ──────────────────────────────────────────────────────────
const TENOR_KEY = process.env.TENOR_KEY || 'LIVDSRZULELA';

app.get('/api/gifs', (req, res) => {
  const q   = encodeURIComponent((req.query.q || 'funny').slice(0, 100));
  const url = `https://g.tenor.com/v1/search?key=${TENOR_KEY}&q=${q}&limit=24&contentfilter=medium&mediafilter=minimal`;
  https.get(url, apiRes => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        const gifs = (json.results || []).map(r => ({
          preview : r.media?.[0]?.tinygif?.url  || '',
          url     : r.media?.[0]?.gif?.url      || '',
        })).filter(g => g.url);
        res.json(gifs);
      } catch { res.json([]); }
    });
  }).on('error', () => res.json([]));
});

// ── Admin API ─────────────────────────────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';

app.get('/admin/:cmd', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  const { cmd } = req.params;
  switch (cmd) {
    case 'clear':
      for (const k of Object.keys(pixels)) delete pixels[k];
      io.emit('clear');
      return res.json({ ok: true, msg: 'Canvas cleared' });
    case 'users':
      return res.json(Object.values(users));
    case 'kick': {
      const target = (req.query.target || '').toLowerCase();
      if (!target) return res.status(400).json({ error: 'Missing target' });
      const match = Object.values(users).find(u =>
        u.name.toLowerCase() === target || u.id.toLowerCase().startsWith(target));
      if (!match) return res.status(404).json({ error: `No user matching "${target}"` });
      io.sockets.sockets.get(match.id)?.disconnect(true);
      return res.json({ ok: true, msg: `Kicked ${match.name}` });
    }
    case 'announce': {
      const msg = req.query.msg || '';
      if (!msg) return res.status(400).json({ error: 'Missing msg' });
      io.emit('announce', msg);
      return res.json({ ok: true, msg: `Announced: "${msg}"` });
    }
    case 'chat': {
      const msg = req.query.msg || '';
      if (!msg) return res.status(400).json({ error: 'Missing msg' });
      const id = ++msgSeq;
      io.emit('chat', { id, userId: null, name: 'Server', color: '#f0c040', text: msg, gif: '', ts: Date.now() });
      return res.json({ ok: true, msg: `[Server] ${msg}` });
    }
    case 'pixels':
      return res.json({ count: Object.keys(pixels).length });
    case 'status':
      return res.json({
        users: Object.keys(users).length,
        pixels: Object.keys(pixels).length,
        canvas: `${CANVAS_W}×${CANVAS_H}`,
        customEmojis: Object.keys(customEmojis).length,
      });
    default:
      return res.status(404).json({ error: `Unknown command "${cmd}"` });
  }
});

// ── Sockets ───────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  const color = pickColor();
  const name  = `Artist ${Math.floor(1000 + Math.random() * 9000)}`;
  users[socket.id] = { id: socket.id, name, color };

  socket.emit('init', {
    userId: socket.id, name, color,
    users, pixels, customEmojis,
    size: { w: CANVAS_W, h: CANVAS_H },
  });
  socket.broadcast.emit('user-joined', users[socket.id]);

  // Drawing
  socket.on('pixels', batch => {
    if (!Array.isArray(batch)) return;
    for (const p of batch) {
      if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
      if (p.x < 0 || p.x >= CANVAS_W || p.y < 0 || p.y >= CANVAS_H) continue;
      const key = `${p.x},${p.y}`;
      if (p.erase) delete pixels[key];
      else if (typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) pixels[key] = p.color;
    }
    socket.broadcast.emit('pixels', { batch, userId: socket.id });
  });

  // Cursor
  socket.on('cursor', data => {
    const u = users[socket.id];
    if (!u) return;
    socket.broadcast.emit('cursor', { userId: socket.id, px: data.px, py: data.py, color: u.color, name: u.name });
  });

  // Chat (text or gif)
  socket.on('chat', data => {
    const u = users[socket.id];
    if (!u) return;
    const text = typeof data.text === 'string' ? data.text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim().slice(0, 300) : '';
    const gif  = typeof data.gif  === 'string' && /^https:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(data.gif) ? data.gif.slice(0, 500) : '';
    if (!text && !gif) return;

    const replyToId = typeof data.replyTo === 'number' ? data.replyTo : null;
    let replyTo = null;
    if (replyToId && chatStore[replyToId]) {
      const ref = chatStore[replyToId];
      replyTo = { id: replyToId, name: ref.name, text: (ref.text || '').slice(0, 80) };
    }

    const id  = ++msgSeq;
    const msg = { id, userId: socket.id, name: u.name, color: u.color, text, gif, replyTo, ts: Date.now() };
    chatStore[id] = { id, userId: socket.id, name: u.name, text, gif, reactions: {} };

    // Prune old messages
    const keys = Object.keys(chatStore);
    if (keys.length > MAX_MESSAGES) delete chatStore[keys[0]];

    io.emit('chat', msg);
  });

  // Reactions
  socket.on('react', ({ msgId, emoji }) => {
    const msg = chatStore[msgId];
    if (!msg || typeof emoji !== 'string' || emoji.length > 32) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = new Set();
    const set = msg.reactions[emoji];
    if (set.has(socket.id)) set.delete(socket.id); else set.add(socket.id);
    if (set.size === 0) delete msg.reactions[emoji];
    // Serialize: emoji -> array of socket IDs
    const serialized = {};
    for (const [em, s] of Object.entries(msg.reactions)) serialized[em] = [...s];
    io.emit('reactions', { msgId, reactions: serialized });
  });

  // Custom emojis
  socket.on('custom-emoji', ({ name: ename, dataUrl }) => {
    if (typeof ename !== 'string' || typeof dataUrl !== 'string') return;
    const clean = ename.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
    if (clean.length < 2) return;
    if (dataUrl.length > 200_000) return; // ~150KB max
    if (!dataUrl.startsWith('data:image/')) return;
    customEmojis[clean] = dataUrl;
    io.emit('custom-emoji', { name: clean, dataUrl });
  });

  // Name
  socket.on('set-name', name => {
    const u = users[socket.id];
    if (!u || typeof name !== 'string') return;
    u.name = name.replace(/[\x00-\x1f]/g, '').trim().slice(0, 24) || u.name;
    io.emit('user-updated', u);
  });

  socket.on('disconnect', () => {
    delete users[socket.id];
    io.emit('user-left', socket.id);
  });
});

// ── Server CLI ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} in use.`); process.exit(1); }
  else throw e;
});
server.listen(PORT, () => {
  console.log(`DrawWall → http://localhost:${PORT}`);
  console.log('Type "help" for commands.\n');
  startCLI();
});

function startCLI() {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', line => {
    const [cmd, ...args] = line.trim().split(/\s+/);
    switch (cmd.toLowerCase()) {
      case 'help':
        console.log(`
  clear               — wipe canvas for all users
  users               — list connected users
  kick <name|id>      — disconnect a user
  announce <msg>      — show banner to all users
  chat <msg>          — send chat message as Server
  pixels              — pixel count
  status              — server stats
  exit / quit         — shut down
`);        break;
      case 'clear':
        for (const k of Object.keys(pixels)) delete pixels[k];
        io.emit('clear');
        console.log('Canvas cleared.');
        break;
      case 'users': {
        const list = Object.values(users);
        if (!list.length) { console.log('No users connected.'); break; }
        console.log(`\n  ${list.length} connected:`);
        list.forEach(u => console.log(`  [${u.id.slice(0,6)}]  ${u.name}  ${u.color}`));
        console.log('');
        break;
      }
      case 'kick': {
        const target = args.join(' ').toLowerCase();
        if (!target) { console.log('Usage: kick <name or id>'); break; }
        const match = Object.values(users).find(u =>
          u.name.toLowerCase() === target || u.id.toLowerCase().startsWith(target));
        if (!match) { console.log(`No user matching "${target}".`); break; }
        io.sockets.sockets.get(match.id)?.disconnect(true);
        console.log(`Kicked ${match.name}.`);
        break;
      }
      case 'announce': {
        const msg = args.join(' ');
        if (!msg) { console.log('Usage: announce <message>'); break; }
        io.emit('announce', msg);
        console.log(`Announced: "${msg}"`);
        break;
      }
      case 'chat': {
        const msg = args.join(' ');
        if (!msg) { console.log('Usage: chat <message>'); break; }
        const id = ++msgSeq;
        io.emit('chat', { id, userId: null, name: 'Server', color: '#e94560', text: msg, gif: '', ts: Date.now() });
        console.log(`[Server] ${msg}`);
        break;
      }
      case 'pixels':
        console.log(`${Object.keys(pixels).length.toLocaleString()} pixels drawn.`);
        break;
      case 'status':
        console.log(`  Users   : ${Object.keys(users).length}`);
        console.log(`  Pixels  : ${Object.keys(pixels).length.toLocaleString()}`);
        console.log(`  Canvas  : ${CANVAS_W}×${CANVAS_H}`);
        console.log(`  Emojis  : ${Object.keys(customEmojis).length} custom`);
        break;
      case 'exit': case 'quit':
        console.log('Shutting down.'); process.exit(0);
      case '': break;
      default: console.log(`Unknown command "${cmd}". Type "help".`);
    }
    rl.prompt();
  });
}
