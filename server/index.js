import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'crypto';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { Server as SocketIOServer } from 'socket.io';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || `http://localhost:${PORT}`;
const MONGO_URL = process.env.MONGO_URL;
const DEFAULT_GROUP = 'shadow-relay';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const TRUST_PROXY = String(process.env.TRUST_PROXY || 'false').toLowerCase() === 'true';
const MESSAGE_MAX_CHARS = Number(process.env.MESSAGE_MAX_CHARS || 2000);
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 10 * 60 * 1000);
const LOGIN_ATTEMPTS = Number(process.env.LOGIN_ATTEMPTS || 8);
const SEND_WINDOW_MS = Number(process.env.SEND_WINDOW_MS || 10 * 1000);
const SEND_ATTEMPTS = Number(process.env.SEND_ATTEMPTS || 24);

const normalizeName = name => {
  const cleaned = (name || '').toString().trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  return cleaned || null;
};

const normalizeGroup = name => {
  const cleaned = (name || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return cleaned || null;
};

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
};

const verifyPassword = (password, stored) => {
  if (!stored || !stored.includes(':')) return false;
  const [salt, expectedHash] = stored.split(':');
  if (!salt || !expectedHash) return false;
  const actual = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(actual, 'hex'));
  } catch {
    return false;
  }
};

const sanitizeText = value => {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MESSAGE_MAX_CHARS);
};

class SlidingWindowLimiter {
  constructor() {
    this.windows = new Map();
  }

  allow(key, limit, windowMs) {
    const now = Date.now();
    const hits = this.windows.get(key) || [];
    const freshHits = hits.filter(ts => now - ts < windowMs);
    if (freshHits.length >= limit) {
      this.windows.set(key, freshHits);
      return false;
    }
    freshHits.push(now);
    this.windows.set(key, freshHits);
    return true;
  }
}

class ChatStore {
  constructor() {
    this.useDb = false;
    this.UserModel = null;
    this.GroupModel = null;
    this.MessageModel = null;
    this.GroupMessageModel = null;
    this.AuditModel = null;

    this.buffers = new Map();
    this.groupBuffers = new Map();
    this.auditBuffer = [];
    this.users = new Map(); // username -> { id, passwordHash }
    this.groups = new Map(); // group -> { owner, admins:Set, members:Set }

    this.MAX_MEDIA_BYTES = 2 * 1024 * 1024;
  }

  keyFor(a, b) {
    return [a, b].sort().join('|');
  }

  async init(mongoUrl) {
    if (!mongoUrl) {
      this.groups.set(DEFAULT_GROUP, {
        owner: ADMIN_USERNAME,
        admins: new Set([ADMIN_USERNAME]),
        members: new Set([ADMIN_USERNAME])
      });
      await this.ensureAdminAccount();
      return;
    }

    try {
      await mongoose.connect(mongoUrl, { dbName: 'chatapp' });

      const userSchema = new mongoose.Schema({
        username: { type: String, unique: true, index: true },
        passwordHash: { type: String, required: true },
        createdAt: { type: Date, default: Date.now }
      });

      const groupSchema = new mongoose.Schema({
        name: { type: String, unique: true, index: true },
        owner: { type: String, required: true },
        admins: { type: [String], default: [] },
        members: { type: [String], default: [] },
        createdAt: { type: Date, default: Date.now }
      });

      const dmSchema = new mongoose.Schema({
        convoKey: { type: String, index: true },
        from: String,
        to: String,
        text: String,
        kind: { type: String, default: 'text' },
        mediaType: String,
        mediaData: String,
        createdAt: { type: Date, default: Date.now }
      });

      const groupMessageSchema = new mongoose.Schema({
        group: { type: String, index: true },
        from: String,
        text: String,
        kind: { type: String, default: 'text' },
        mediaType: String,
        mediaData: String,
        createdAt: { type: Date, default: Date.now }
      });

      const auditSchema = new mongoose.Schema({
        actor: String,
        action: String,
        target: String,
        detail: String,
        createdAt: { type: Date, default: Date.now }
      });

      this.UserModel = mongoose.model('User', userSchema);
      this.GroupModel = mongoose.model('ChatGroup', groupSchema);
      this.MessageModel = mongoose.model('DmMessage', dmSchema);
      this.GroupMessageModel = mongoose.model('GroupMessage', groupMessageSchema);
      this.AuditModel = mongoose.model('AuditLog', auditSchema);

      await this.GroupModel.updateOne(
        { name: DEFAULT_GROUP },
        {
          $setOnInsert: {
            name: DEFAULT_GROUP,
            owner: ADMIN_USERNAME,
            admins: [ADMIN_USERNAME],
            members: [ADMIN_USERNAME]
          }
        },
        { upsert: true }
      );

      this.useDb = true;
      await this.ensureAdminAccount();
      console.log('[mongo] connected');
    } catch (err) {
      console.warn('[mongo] connection failed, using in-memory store', err.message);
      this.useDb = false;
      this.groups.set(DEFAULT_GROUP, {
        owner: ADMIN_USERNAME,
        admins: new Set([ADMIN_USERNAME]),
        members: new Set([ADMIN_USERNAME])
      });
      await this.ensureAdminAccount();
    }
  }

  async ensureAdminAccount() {
    if (this.useDb && this.UserModel) {
      await this.UserModel.updateOne(
        { username: ADMIN_USERNAME },
        { $setOnInsert: { passwordHash: hashPassword(ADMIN_PASSWORD) } },
        { upsert: true }
      );
      return;
    }

    const existing = this.users.get(ADMIN_USERNAME);
    if (existing) return;

    this.users.set(ADMIN_USERNAME, {
      id: crypto.randomUUID(),
      passwordHash: hashPassword(ADMIN_PASSWORD),
      createdAt: new Date()
    });
  }

  validateMedia({ kind, mediaData }) {
    if (kind === 'text') return { ok: true };
    if (!mediaData) return { ok: false, reason: 'missing media' };
    if (!String(mediaData).startsWith('data:')) return { ok: false, reason: 'invalid media format' };
    const approxBytes = Buffer.byteLength(mediaData, 'utf8');
    if (approxBytes > this.MAX_MEDIA_BYTES) return { ok: false, reason: 'media too large' };
    return { ok: true };
  }

  async loginOrRegister({ username, password }) {
    if (!username || !password || password.length < 4) {
      return { ok: false, reason: 'Username and password are required (password min 4 chars).' };
    }

    if (username === ADMIN_USERNAME) {
      if (password !== ADMIN_PASSWORD) return { ok: false, reason: 'Invalid admin credentials.' };
      await this.ensureAdminAccount();
      if (this.useDb && this.UserModel) {
        const admin = await this.UserModel.findOne({ username: ADMIN_USERNAME }).lean().exec();
        return { ok: true, userId: String(admin._id), username, created: false, isAdmin: true };
      }
      const admin = this.users.get(ADMIN_USERNAME);
      return { ok: true, userId: admin.id, username, created: false, isAdmin: true };
    }

    if (this.useDb && this.UserModel) {
      const existing = await this.UserModel.findOne({ username }).exec();
      if (!existing) {
        const created = await this.UserModel.create({ username, passwordHash: hashPassword(password), createdAt: new Date() });
        return { ok: true, userId: String(created._id), username, created: true, isAdmin: false };
      }
      if (!verifyPassword(password, existing.passwordHash)) {
        return { ok: false, reason: 'Invalid username or password.' };
      }
      return { ok: true, userId: String(existing._id), username, created: false, isAdmin: false };
    }

    const existing = this.users.get(username);
    if (!existing) {
      const id = crypto.randomUUID();
      this.users.set(username, { id, passwordHash: hashPassword(password), createdAt: new Date() });
      return { ok: true, userId: id, username, created: true, isAdmin: false };
    }
    if (!verifyPassword(password, existing.passwordHash)) {
      return { ok: false, reason: 'Invalid username or password.' };
    }
    return { ok: true, userId: existing.id, username, created: false, isAdmin: false };
  }

  async listUsers() {
    if (this.useDb && this.UserModel) {
      const users = await this.UserModel.find({}).sort({ username: 1 }).lean().exec();
      return users.map(u => ({ username: u.username, createdAt: u.createdAt }));
    }

    return Array.from(this.users.entries())
      .map(([username, value]) => ({ username, createdAt: value.createdAt || null }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async upsertUser({ username, password }) {
    const normalized = normalizeName(username);
    if (!normalized || !password || password.length < 4) {
      return { ok: false, reason: 'Invalid username or password.' };
    }
    if (normalized === ADMIN_USERNAME) {
      return { ok: false, reason: 'Admin user is managed by system.' };
    }

    if (this.useDb && this.UserModel) {
      await this.UserModel.updateOne(
        { username: normalized },
        { $set: { passwordHash: hashPassword(password), createdAt: new Date() } },
        { upsert: true }
      );
      return { ok: true };
    }

    const existing = this.users.get(normalized);
    if (existing) {
      existing.passwordHash = hashPassword(password);
      return { ok: true };
    }

    this.users.set(normalized, { id: crypto.randomUUID(), passwordHash: hashPassword(password), createdAt: new Date() });
    return { ok: true };
  }

  async removeUser(username) {
    const normalized = normalizeName(username);
    if (!normalized || normalized === ADMIN_USERNAME) return { ok: false, reason: 'Cannot remove this user.' };

    if (this.useDb && this.UserModel) {
      await this.UserModel.deleteOne({ username: normalized }).exec();
      await this.removeUserFromAllGroups(normalized);
      return { ok: true };
    }

    this.users.delete(normalized);
    await this.removeUserFromAllGroups(normalized);
    return { ok: true };
  }

  async ensureGroup(name, owner = ADMIN_USERNAME) {
    const group = normalizeGroup(name);
    if (!group) return null;

    if (this.useDb && this.GroupModel) {
      await this.GroupModel.updateOne(
        { name: group },
        { $setOnInsert: { name: group, owner, admins: [owner], members: [owner] } },
        { upsert: true }
      );
      return group;
    }

    if (!this.groups.has(group)) {
      this.groups.set(group, {
        owner,
        admins: new Set([owner]),
        members: new Set([owner])
      });
    }
    return group;
  }

  async listGroupsForUser(username) {
    if (this.useDb && this.GroupModel) {
      const groups = await this.GroupModel.find({ members: username }).sort({ name: 1 }).lean().exec();
      return groups.map(g => g.name);
    }

    const result = [];
    for (const [name, group] of this.groups.entries()) {
      if (group.members.has(username)) result.push(name);
    }
    return result.sort();
  }

  async listDiscoverableGroups(username) {
    if (this.useDb && this.GroupModel) {
      const groups = await this.GroupModel.find({ members: { $ne: username } }).sort({ name: 1 }).lean().exec();
      return groups.map(g => g.name);
    }

    const result = [];
    for (const [name, group] of this.groups.entries()) {
      if (!group.members.has(username)) result.push(name);
    }
    return result.sort();
  }

  async addGroupMember(groupName, username) {
    const group = normalizeGroup(groupName);
    if (!group || !username) return { ok: false };

    if (this.useDb && this.GroupModel) {
      const updated = await this.GroupModel.findOneAndUpdate(
        { name: group },
        { $addToSet: { members: username } },
        { new: true }
      ).lean().exec();
      if (!updated) return { ok: false };
      return { ok: true };
    }

    const existing = this.groups.get(group);
    if (!existing) return { ok: false };
    existing.members.add(username);
    return { ok: true };
  }

  async getGroup(groupName) {
    const group = normalizeGroup(groupName);
    if (!group) return null;

    if (this.useDb && this.GroupModel) {
      return this.GroupModel.findOne({ name: group }).lean().exec();
    }

    const g = this.groups.get(group);
    if (!g) return null;
    return {
      name: group,
      owner: g.owner,
      admins: Array.from(g.admins),
      members: Array.from(g.members)
    };
  }

  async getGroupRole(groupName, username) {
    const group = await this.getGroup(groupName);
    if (!group) return 'none';
    if (group.owner === username) return 'owner';
    if ((group.admins || []).includes(username)) return 'admin';
    if ((group.members || []).includes(username)) return 'member';
    return 'none';
  }

  async listGroupMembers(groupName, requester) {
    const group = await this.getGroup(groupName);
    if (!group) return null;
    if (!(group.members || []).includes(requester) && requester !== ADMIN_USERNAME) return null;

    const members = (group.members || []).map(u => ({
      username: u,
      role: group.owner === u ? 'owner' : (group.admins || []).includes(u) ? 'admin' : 'member'
    }));

    members.sort((a, b) => a.username.localeCompare(b.username));

    return {
      group: group.name || normalizeGroup(groupName),
      owner: group.owner,
      admins: group.admins || [],
      members,
      myRole: requester === ADMIN_USERNAME ? 'owner' : (group.owner === requester ? 'owner' : (group.admins || []).includes(requester) ? 'admin' : 'member')
    };
  }

  async setGroupRole(groupName, actor, targetUser, role) {
    const group = await this.getGroup(groupName);
    if (!group) return { ok: false, reason: 'Group not found.' };
    if (!(group.members || []).includes(targetUser)) return { ok: false, reason: 'Target user is not in group.' };
    if (targetUser === group.owner) return { ok: false, reason: 'Cannot change owner role.' };

    const actorRole = await this.getGroupRole(groupName, actor);
    if (!(actor === ADMIN_USERNAME || actorRole === 'owner' || actorRole === 'admin')) {
      return { ok: false, reason: 'Not allowed.' };
    }

    const normalizedRole = role === 'admin' ? 'admin' : 'member';

    if (this.useDb && this.GroupModel) {
      if (normalizedRole === 'admin') {
        await this.GroupModel.updateOne({ name: groupName }, { $addToSet: { admins: targetUser } }).exec();
      } else {
        await this.GroupModel.updateOne({ name: groupName }, { $pull: { admins: targetUser } }).exec();
      }
      return { ok: true };
    }

    const local = this.groups.get(groupName);
    if (!local) return { ok: false, reason: 'Group not found.' };
    if (normalizedRole === 'admin') local.admins.add(targetUser);
    else local.admins.delete(targetUser);
    return { ok: true };
  }

  async removeGroupMember(groupName, actor, targetUser) {
    const group = await this.getGroup(groupName);
    if (!group) return { ok: false, reason: 'Group not found.' };
    if (targetUser === group.owner) return { ok: false, reason: 'Cannot remove owner.' };

    const actorRole = await this.getGroupRole(groupName, actor);
    if (!(actor === ADMIN_USERNAME || actorRole === 'owner' || actorRole === 'admin')) {
      return { ok: false, reason: 'Not allowed.' };
    }

    if (this.useDb && this.GroupModel) {
      await this.GroupModel.updateOne({ name: groupName }, { $pull: { members: targetUser, admins: targetUser } }).exec();
      return { ok: true };
    }

    const local = this.groups.get(groupName);
    if (!local) return { ok: false, reason: 'Group not found.' };
    local.members.delete(targetUser);
    local.admins.delete(targetUser);
    return { ok: true };
  }

  async leaveGroup(groupName, username) {
    const group = await this.getGroup(groupName);
    if (!group) return { ok: false, reason: 'Group not found.' };
    if (!(group.members || []).includes(username)) return { ok: false, reason: 'You are not in this group.' };
    if (group.owner === username) return { ok: false, reason: 'Owner cannot leave their own group.' };

    if (this.useDb && this.GroupModel) {
      await this.GroupModel.updateOne({ name: groupName }, { $pull: { members: username, admins: username } }).exec();
      return { ok: true };
    }

    const local = this.groups.get(groupName);
    if (!local) return { ok: false, reason: 'Group not found.' };
    local.members.delete(username);
    local.admins.delete(username);
    return { ok: true };
  }

  async removeUserFromAllGroups(username) {
    if (this.useDb && this.GroupModel) {
      await this.GroupModel.updateMany({}, { $pull: { members: username, admins: username } }).exec();
      return;
    }

    for (const group of this.groups.values()) {
      if (group.owner !== username) {
        group.members.delete(username);
        group.admins.delete(username);
      }
    }
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
      return docs.map(d => ({
        id: String(d._id),
        from: d.from,
        to: d.to,
        text: d.text,
        kind: d.kind,
        mediaType: d.mediaType,
        mediaData: d.mediaData,
        createdAt: d.createdAt
      })).reverse();
    }

    return [...(this.buffers.get(convoKey) || [])];
  }

  async addGroupMessage({ group, from, text, kind = 'text', mediaType = null, mediaData = null }) {
    const payload = { group, from, text, kind, mediaType, mediaData, createdAt: new Date() };

    if (this.useDb && this.GroupMessageModel) {
      const doc = new this.GroupMessageModel(payload);
      await doc.save();
      return { id: String(doc._id), ...payload };
    }

    const entry = { id: crypto.randomUUID(), ...payload };
    const arr = this.groupBuffers.get(group) || [];
    arr.push(entry);
    this.groupBuffers.set(group, arr.slice(-200));
    return entry;
  }

  async addAudit({ actor, action, target = '', detail = '' }) {
    const payload = {
      actor: String(actor || 'system'),
      action: String(action || 'unknown'),
      target: String(target || ''),
      detail: String(detail || ''),
      createdAt: new Date()
    };

    if (this.useDb && this.AuditModel) {
      const doc = new this.AuditModel(payload);
      await doc.save();
      return { id: String(doc._id), ...payload };
    }

    const entry = { id: crypto.randomUUID(), ...payload };
    this.auditBuffer.push(entry);
    this.auditBuffer = this.auditBuffer.slice(-300);
    return entry;
  }

  async listAudits(limit = 100) {
    if (this.useDb && this.AuditModel) {
      const docs = await this.AuditModel.find({}).sort({ createdAt: -1 }).limit(limit).lean().exec();
      return docs.map(d => ({
        id: String(d._id),
        actor: d.actor,
        action: d.action,
        target: d.target,
        detail: d.detail,
        createdAt: d.createdAt
      }));
    }

    return [...this.auditBuffer].reverse().slice(0, limit);
  }

  async listGroupMessages(group, limit = 100) {
    if (this.useDb && this.GroupMessageModel) {
      const docs = await this.GroupMessageModel.find({ group }).sort({ createdAt: -1 }).limit(limit).lean().exec();
      return docs.map(d => ({
        id: String(d._id),
        group: d.group,
        from: d.from,
        text: d.text,
        kind: d.kind,
        mediaType: d.mediaType,
        mediaData: d.mediaData,
        createdAt: d.createdAt
      })).reverse();
    }

    return [...(this.groupBuffers.get(group) || [])];
  }
}

const store = new ChatStore();
await store.init(MONGO_URL);
const loginRateLimiter = new SlidingWindowLimiter();
const sendRateLimiter = new SlidingWindowLimiter();

const app = express();
if (TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Request-Id', crypto.randomUUID());
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      connectSrc: ["'self'", CLIENT_ORIGIN],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'data:', 'blob:']
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(compression());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(cors({ origin: CLIENT_ORIGIN, methods: ['GET', 'POST'], credentials: false }));
app.use(express.json());
app.use('/api', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    storage: store.useDb ? 'mongodb' : 'memory',
    auth: 'username_password',
    defaultGroup: DEFAULT_GROUP,
    adminUser: ADMIN_USERNAME,
    security: {
      helmet: true,
      compression: true,
      requestRateLimit: true,
      messageRateLimit: true
    }
  });
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] }
});

const online = new Map(); // username -> Set<socketId>
const adminSockets = new Set();

const broadcastPresence = () => {
  io.emit('presence:update', { users: Array.from(online.keys()) });
};

const emitGroupsForUser = async (socket, username) => {
  const memberGroups = await store.listGroupsForUser(username);
  const discoverableGroups = await store.listDiscoverableGroups(username);
  socket.emit('group:list', { memberGroups, discoverableGroups, defaultGroup: DEFAULT_GROUP });
};

const emitAuditSnapshot = async () => {
  if (adminSockets.size === 0) return;
  const logs = await store.listAudits(120);
  for (const sid of adminSockets) {
    io.to(sid).emit('admin:audit', { logs });
  }
};

io.on('connection', socket => {
  let username = null;
  let userId = null;
  let isAdmin = false;
  const clientIp = String(socket.handshake.address || 'unknown');

  socket.on('auth:login', async payload => {
    try {
      const normalized = normalizeName(payload?.username);
      const password = (payload?.password || '').toString();
      const loginKey = `${clientIp}:${normalized || 'unknown'}`;
      if (!loginRateLimiter.allow(loginKey, LOGIN_ATTEMPTS, LOGIN_WINDOW_MS)) {
        socket.emit('auth:error', { message: 'Too many login attempts. Try again later.' });
        return;
      }
      if (!normalized) {
        socket.emit('auth:error', { message: 'Invalid username. Use letters, numbers, _ or -.' });
        return;
      }

      const result = await store.loginOrRegister({ username: normalized, password });
      if (!result.ok) {
        socket.emit('auth:error', { message: result.reason });
        return;
      }

      username = normalized;
      userId = result.userId;
      isAdmin = !!result.isAdmin;
      if (isAdmin) adminSockets.add(socket.id);

      if (!online.has(username)) online.set(username, new Set());
      online.get(username).add(socket.id);
      socket.join(`user:${username}`);

      socket.emit('auth:ok', { username, userId, created: result.created, isAdmin });
      await emitGroupsForUser(socket, username);
      socket.emit('presence:update', { users: Array.from(online.keys()) });
      if (isAdmin) {
        await store.addAudit({ actor: username, action: 'admin.login', target: username, detail: 'Admin session started' });
        await emitAuditSnapshot();
      }
      broadcastPresence();
    } catch {
      socket.emit('auth:error', { message: 'Login failed. Please try again.' });
    }
  });

  socket.on('presence:list', () => {
    socket.emit('presence:update', { users: Array.from(online.keys()) });
  });

  socket.on('group:list', async () => {
    if (!username) return;
    await emitGroupsForUser(socket, username);
  });

  socket.on('group:create', async ({ name }) => {
    if (!username) return;
    const group = await store.ensureGroup(name, username);
    if (!group) return;

    await store.addGroupMember(group, username);
    socket.join(`group:${group}`);

    await emitGroupsForUser(socket, username);
    socket.emit('group:joined', { group });

    await store.addAudit({ actor: username, action: 'group.create', target: group, detail: `Owner=${username}` });
    await emitAuditSnapshot();
  });

  socket.on('group:join', async ({ group }) => {
    if (!username) return;
    const normalized = normalizeGroup(group);
    if (!normalized) return;

    const existing = await store.getGroup(normalized);
    if (!existing) {
      socket.emit('app:error', { message: 'Group not found.' });
      return;
    }

    await store.addGroupMember(normalized, username);
    socket.join(`group:${normalized}`);

    await emitGroupsForUser(socket, username);
    socket.emit('group:joined', { group: normalized });

    await store.addAudit({ actor: username, action: 'group.join', target: normalized, detail: 'Joined group' });
    await emitAuditSnapshot();
  });

  socket.on('group:leave', async ({ group }) => {
    if (!username) return;
    const normalized = normalizeGroup(group);
    if (!normalized) return;

    const left = await store.leaveGroup(normalized, username);
    if (!left.ok) {
      socket.emit('app:error', { message: left.reason || 'Unable to leave group.' });
      return;
    }

    socket.leave(`group:${normalized}`);
    await emitGroupsForUser(socket, username);
    socket.emit('group:left', { group: normalized });

    await store.addAudit({ actor: username, action: 'group.leave', target: normalized, detail: 'Left group' });
    await emitAuditSnapshot();
  });

  socket.on('group:members:list', async ({ group }) => {
    if (!username) return;
    const normalized = normalizeGroup(group);
    if (!normalized) return;

    const details = await store.listGroupMembers(normalized, username);
    if (!details) {
      socket.emit('app:error', { message: 'Not allowed to view members for this group.' });
      return;
    }
    socket.emit('group:members', details);
  });

  socket.on('group:member:role', async ({ group, targetUser, role }) => {
    if (!username) return;
    const normalizedGroup = normalizeGroup(group);
    const normalizedUser = normalizeName(targetUser);
    if (!normalizedGroup || !normalizedUser) return;

    const updated = await store.setGroupRole(normalizedGroup, username, normalizedUser, role);
    if (!updated.ok) {
      socket.emit('app:error', { message: updated.reason || 'Role update failed.' });
      return;
    }

    const set = online.get(normalizedUser);
    if (set) {
      for (const sid of set) {
        io.to(sid).emit('group:members', await store.listGroupMembers(normalizedGroup, normalizedUser));
      }
    }

    io.to(`group:${normalizedGroup}`).emit('group:members', await store.listGroupMembers(normalizedGroup, username));

    await store.addAudit({
      actor: username,
      action: 'group.member.role',
      target: `${normalizedGroup}:${normalizedUser}`,
      detail: `Set role=${role === 'admin' ? 'admin' : 'member'}`
    });
    await emitAuditSnapshot();
  });

  socket.on('group:member:remove', async ({ group, targetUser }) => {
    if (!username) return;
    const normalizedGroup = normalizeGroup(group);
    const normalizedUser = normalizeName(targetUser);
    if (!normalizedGroup || !normalizedUser) return;

    const removed = await store.removeGroupMember(normalizedGroup, username, normalizedUser);
    if (!removed.ok) {
      socket.emit('app:error', { message: removed.reason || 'Unable to remove member.' });
      return;
    }

    const set = online.get(normalizedUser);
    if (set) {
      for (const sid of set) {
        io.sockets.sockets.get(sid)?.leave(`group:${normalizedGroup}`);
        io.to(sid).emit('app:error', { message: `Removed from group ${normalizedGroup}.` });
        io.to(sid).emit('group:list', {
          memberGroups: await store.listGroupsForUser(normalizedUser),
          discoverableGroups: await store.listDiscoverableGroups(normalizedUser),
          defaultGroup: DEFAULT_GROUP
        });
      }
    }

    io.to(`group:${normalizedGroup}`).emit('group:members', await store.listGroupMembers(normalizedGroup, username));

    await store.addAudit({
      actor: username,
      action: 'group.member.remove',
      target: `${normalizedGroup}:${normalizedUser}`,
      detail: 'Member removed from group'
    });
    await emitAuditSnapshot();
  });

  socket.on('group:history', async ({ group }) => {
    if (!username) return;
    const normalized = normalizeGroup(group);
    if (!normalized) return;

    const role = await store.getGroupRole(normalized, username);
    if (role === 'none') {
      socket.emit('app:error', { message: 'Join this group before viewing history.' });
      return;
    }

    const history = await store.listGroupMessages(normalized);
    socket.emit('group:history', { group: normalized, messages: history });
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
    if (!sendRateLimiter.allow(`dm:${username}`, SEND_ATTEMPTS, SEND_WINDOW_MS)) {
      socket.emit('app:error', { message: 'Rate limit reached. Slow down.' });
      return;
    }

    const to = normalizeName(payload?.to);
    const kind = (payload?.kind || 'text').toString();
    const text = sanitizeText(payload?.text);
    const mediaType = payload?.mediaType ? String(payload.mediaType) : null;
    const mediaData = payload?.mediaData ? String(payload.mediaData) : null;
    const allowedKinds = new Set(['text', 'image', 'video', 'audio']);

    if (!to) return;
    if (!allowedKinds.has(kind)) return;
    if (kind === 'text' && !text) return;
    if (kind !== 'text') {
      const ok = store.validateMedia({ kind, mediaData });
      if (!ok.ok) return;
    }

    const saved = await store.add({ from: username, to, text, kind, mediaType, mediaData });
    io.to(`user:${to}`).to(`user:${username}`).emit('dm:message', saved);
  });

  socket.on('group:send', async payload => {
    if (!username) return;
    if (!sendRateLimiter.allow(`group:${username}`, SEND_ATTEMPTS, SEND_WINDOW_MS)) {
      socket.emit('app:error', { message: 'Rate limit reached. Slow down.' });
      return;
    }

    const group = normalizeGroup(payload?.group);
    const kind = (payload?.kind || 'text').toString();
    const text = sanitizeText(payload?.text);
    const mediaType = payload?.mediaType ? String(payload.mediaType) : null;
    const mediaData = payload?.mediaData ? String(payload.mediaData) : null;
    const allowedKinds = new Set(['text', 'image', 'video', 'audio']);

    if (!group) return;
    if (!allowedKinds.has(kind)) return;
    if (kind === 'text' && !text) return;
    if (kind !== 'text') {
      const ok = store.validateMedia({ kind, mediaData });
      if (!ok.ok) return;
    }

    const role = await store.getGroupRole(group, username);
    if (role === 'none') {
      socket.emit('app:error', { message: 'You are not a member of this group.' });
      return;
    }

    const saved = await store.addGroupMessage({ group, from: username, text, kind, mediaType, mediaData });
    io.to(`group:${group}`).emit('group:message', saved);
  });

  socket.on('dm:typing', ({ to, isTyping }) => {
    if (!username) return;
    const target = normalizeName(to);
    if (!target) return;
    io.to(`user:${target}`).emit('dm:typing', { from: username, to: target, isTyping: !!isTyping });
  });

  socket.on('group:typing', async ({ group, isTyping }) => {
    if (!username) return;
    const normalized = normalizeGroup(group);
    if (!normalized) return;
    const role = await store.getGroupRole(normalized, username);
    if (role === 'none') return;
    socket.to(`group:${normalized}`).emit('group:typing', {
      group: normalized,
      from: username,
      isTyping: !!isTyping
    });
  });

  socket.on('admin:users:list', async () => {
    if (!username || !isAdmin) return;
    socket.emit('admin:users', { users: await store.listUsers() });
  });

  socket.on('admin:audit:list', async () => {
    if (!username || !isAdmin) return;
    socket.emit('admin:audit', { logs: await store.listAudits(120) });
  });

  socket.on('admin:user:add', async ({ username: newUsername, password }) => {
    if (!username || !isAdmin) return;
    const result = await store.upsertUser({ username: newUsername, password });
    if (!result.ok) {
      socket.emit('app:error', { message: result.reason || 'Unable to add user.' });
      return;
    }
    socket.emit('admin:users', { users: await store.listUsers() });

    await store.addAudit({
      actor: username,
      action: 'admin.user.upsert',
      target: normalizeName(newUsername) || String(newUsername || ''),
      detail: 'User added or password updated'
    });
    await emitAuditSnapshot();
  });

  socket.on('admin:user:remove', async ({ username: target }) => {
    if (!username || !isAdmin) return;
    const normalizedTarget = normalizeName(target);
    const result = await store.removeUser(normalizedTarget);
    if (!result.ok) {
      socket.emit('app:error', { message: result.reason || 'Unable to remove user.' });
      return;
    }

    const set = online.get(normalizedTarget);
    if (set) {
      for (const sid of set) {
        io.to(sid).emit('app:error', { message: 'Your account has been removed by admin.' });
        io.sockets.sockets.get(sid)?.disconnect(true);
      }
      online.delete(normalizedTarget);
      broadcastPresence();
    }

    socket.emit('admin:users', { users: await store.listUsers() });

    await store.addAudit({
      actor: username,
      action: 'admin.user.remove',
      target: normalizedTarget,
      detail: 'User removed by admin'
    });
    await emitAuditSnapshot();
  });

  socket.on('disconnect', () => {
    adminSockets.delete(socket.id);
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
