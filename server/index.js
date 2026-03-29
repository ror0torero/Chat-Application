import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { Server as SocketIOServer } from 'socket.io';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || `http://localhost:${PORT}`;
const MONGO_URL = process.env.MONGO_URL;

const normalizeName = name => {
  const cleaned = (name || '').toString().trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  return cleaned || null;
};

class DMStore {
  constructor() {
    this.useDb = false;
    this.MessageModel = null;
    this.buffers = new Map(); // convoKey -> array
    this.MAX_MEDIA_BYTES = 2 * 1024 * 1024; // ~2MB data URL cap for demo
  }

  keyFor(a, b) {
    return [a, b].sort().join('|');
  }

  async init(mongoUrl) {
    if (!mongoUrl) return;
    try {
      await mongoose.connect(mongoUrl, { dbName: 'chatapp' });
      const schema = new mongoose.Schema({
        convoKey: { type: String, index: true },
        from: String,
        to: String,
        text: String,
        kind: { type: String, default: 'text' },
        mediaType: String,
        mediaData: String,
        createdAt: { type: Date, default: Date.now }
      });
      this.MessageModel = mongoose.model('DmMessage', schema);
      this.useDb = true;
      console.log('[mongo] connected');
    } catch (err) {
      console.warn('[mongo] connection failed, using in-memory store', err.message);
      this.useDb = false;
    }
  }

  validateMedia({ kind, mediaData }) {
    if (kind === 'text') return { ok: true };
    if (!mediaData) return { ok: false, reason: 'missing media' };
    const approxBytes = Buffer.byteLength(mediaData, 'utf8');
    if (approxBytes > this.MAX_MEDIA_BYTES) return { ok: false, reason: 'media too large' };
    return { ok: true };
  }

  async add({ from, to, text, kind = 'text', mediaType = null, mediaData = null }) {
    const payload = { from, to, text, kind, mediaType, mediaData, createdAt: new Date() };
    const convoKey = this.keyFor(from, to);
    if (this.useDb && this.MessageModel) {
      const doc = new this.MessageModel({ convoKey, ...payload });
      await doc.save();
      return { id: String(doc._id), ...payload };
    }
    const entry = { id: crypto.randomUUID(), ...payload };
    const arr = this.buffers.get(convoKey) || [];
    arr.push(entry);
    this.buffers.set(convoKey, arr.slice(-100));
    return entry;
  }

  async list(a, b, limit = 50) {
    const convoKey = this.keyFor(a, b);
    if (this.useDb && this.MessageModel) {
      const docs = await this.MessageModel.find({ convoKey }).sort({ createdAt: -1 }).limit(limit).lean().exec();
      return docs
        .map(d => ({
          id: String(d._id),
          from: d.from,
          to: d.to,
          text: d.text,
          kind: d.kind,
          mediaType: d.mediaType,
          mediaData: d.mediaData,
          createdAt: d.createdAt
        }))
        .reverse();
    }
    return [...(this.buffers.get(convoKey) || [])];
  }
}

const store = new DMStore();
await store.init(MONGO_URL);

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN, methods: ['GET', 'POST'], credentials: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', mongo: store.useDb ? 'connected' : 'memory' });
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] }
});

const online = new Map(); // username -> Set<socketId>

const broadcastPresence = () => {
  io.emit('presence:update', { users: Array.from(online.keys()) });
};

io.on('connection', socket => {
  let username = null;

  socket.on('auth:login', name => {
    const normalized = normalizeName(name);
    if (!normalized) return;
    username = normalized;
    if (!online.has(username)) online.set(username, new Set());
    online.get(username).add(socket.id);
    socket.join(`user:${username}`);
    socket.emit('auth:ok', { username });
    broadcastPresence();
    socket.emit('presence:update', { users: Array.from(online.keys()) });
  });

  socket.on('presence:list', () => {
    socket.emit('presence:update', { users: Array.from(online.keys()) });
  });

  socket.on('dm:history', async ({ withUser }) => {
    if (!username || !withUser) return;
    const partner = normalizeName(withUser);
    if (!partner) return;
    const history = await store.list(username, partner);
    socket.emit('dm:history', { withUser: partner, messages: history });
  });

  socket.on('dm:send', async payload => {
    if (!username) return;
    const to = normalizeName(payload?.to);
    const kind = (payload?.kind || 'text').toString();
    const text = (payload?.text || '').toString().trim().slice(0, 2000);
    const mediaType = payload?.mediaType ? String(payload.mediaType) : null;
    const mediaData = payload?.mediaData ? String(payload.mediaData) : null;
    if (!to) return;
    if (kind === 'text' && !text) return;
    if (kind !== 'text') {
      const ok = store.validateMedia({ kind, mediaData });
      if (!ok.ok) return;
    }
    const saved = await store.add({ from: username, to, text, kind, mediaType, mediaData });
    const targetRoom = `user:${to}`;
    io.to(targetRoom).to(`user:${username}`).emit('dm:message', saved);
  });

  socket.on('disconnect', () => {
    if (!username) return;
    const set = online.get(username);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) online.delete(username);
    }
    broadcastPresence();
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`[server] running on http://localhost:${PORT}`);
});
