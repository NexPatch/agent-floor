// Agent Floor server. Zero dependencies.
//
//   POST /events            one event or an array of events (see docs/protocol.md)
//   GET  /stream?world=     Server-Sent Events: a `snapshot`, then `event` + `effects`
//   GET  /state?world=      current world as JSON
//   GET  /worlds            the worlds (one per organization): [{ id, name, agents, attention }]
//   POST /reset?world=      clear one world; without `world`, clear every world
//   POST /avatars/<agent>   an agent's picture (PNG, JPEG or WebP, up to 64 KB)
//   GET  /avatars/<agent>   the picture
//   GET  /*                 the built web app (dist/)
//
// Everything is kept in memory and bounded: at most MAX_WORLDS worlds and
// MAX_AVATARS pictures. `?org=` is an alias of `?world=`.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEvent, createState, normalizeEvent, sweep, worldId, DEFAULT_WORLD, PROTOCOL_VERSION } from '../shared/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 256 * 1024;
const MAX_WORLDS = 16;
const MAX_AVATARS = 512;
const MAX_AVATAR_BYTES = 64 * 1024;
const AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/** The picture types we accept, each with the bytes its files start with. */
const AVATAR_TYPES = {
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

function titleCase(value) {
  return String(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function startServer({
  port = Number(process.env.AGENT_FLOOR_PORT) || 4317,
  host = process.env.AGENT_FLOOR_HOST || '127.0.0.1',
  staticDir = resolve(here, '../dist'),
  log = console.log,
} = {}) {
  /** id -> { id, name, state }, in the order they first appeared. */
  const worlds = new Map();
  /** world id -> the open streams watching it (a world may not exist yet). */
  const watchers = new Map();
  /** agent id -> { type, body, etag }; the oldest is dropped past MAX_AVATARS. */
  const avatars = new Map();
  let worldsKey = '';

  function getWorld(id, name) {
    let w = worlds.get(id);
    if (!w) {
      if (worlds.size >= MAX_WORLDS) return null;
      w = { id, name: name || titleCase(id), state: createState() };
      worlds.set(id, w);
    } else if (name && w.name !== name) {
      w.name = name;
    }
    return w;
  }

  /**
   * The world a request without `?world=` means: `default` while it has anyone
   * (or nothing else exists), otherwise the first world. A single-floor setup
   * that never sends `world` therefore behaves exactly as before.
   */
  function defaultWorld() {
    const d = worlds.get(DEFAULT_WORLD);
    if (d && Object.keys(d.state.agents).length) return DEFAULT_WORLD;
    for (const w of worlds.values()) if (Object.keys(w.state.agents).length) return w.id;
    return worlds.keys().next().value ?? DEFAULT_WORLD;
  }

  /** `?world=` (or its alias `?org=`): a world id, `undefined` when absent, `null` when invalid. */
  function worldParam(url) {
    const raw = url.searchParams.get('world') ?? url.searchParams.get('org');
    if (raw == null || raw === '') return undefined;
    return worldId(raw);
  }

  function summary() {
    return [...worlds.values()].map((w) => {
      const agents = Object.values(w.state.agents);
      return {
        id: w.id,
        name: w.name,
        agents: agents.length,
        attention: agents.some((a) => a.status === 'waiting' || a.status === 'error'),
      };
    });
  }

  function send(world, name, data) {
    const set = watchers.get(world);
    if (!set) return;
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(frame);
  }

  /** Tell every stream when the list of worlds, their sizes or attention flags change. */
  function announceWorlds() {
    const list = summary();
    const key = JSON.stringify(list);
    if (key === worldsKey) return;
    worldsKey = key;
    const frame = `event: worlds\ndata: ${JSON.stringify({ worlds: list })}\n\n`;
    for (const set of watchers.values()) for (const res of set) res.write(frame);
  }

  function ingest(raw) {
    const ev = normalizeEvent(raw);
    if (!ev) return false;
    const w = ev.type === 'reset' ? worlds.get(ev.world) : getWorld(ev.world, ev.worldName);
    if (!w) return ev.type === 'reset';
    const { effects } = applyEvent(w.state, ev);
    send(w.id, 'event', { event: ev, effects });
    return true;
  }

  function resetWorld(w) {
    applyEvent(w.state, { type: 'reset', ts: Date.now(), world: w.id });
    send(w.id, 'event', { event: { type: 'reset', ts: Date.now(), world: w.id }, effects: [{ kind: 'reset' }] });
  }

  const sweeper = setInterval(() => {
    for (const w of [...worlds.values()]) {
      const removed = sweep(w.state);
      if (removed.length) send(w.id, 'removed', { agents: removed });
      // An empty world frees its slot; streams watching it simply stay empty.
      if (!Object.keys(w.state.agents).length && w.id !== DEFAULT_WORLD) worlds.delete(w.id);
    }
    announceWorlds();
  }, 2000);
  const heartbeat = setInterval(() => {
    for (const set of watchers.values()) for (const res of set) res.write(': ping\n\n');
  }, 20000);

  async function readRaw(req, max) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) throw Object.assign(new Error('Body too large'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function readBody(req) {
    const text = (await readRaw(req, MAX_BODY)).toString('utf8');
    return text ? JSON.parse(text) : null;
  }

  function cors(req, res) {
    // Local tool: allow any localhost origin plus the hosted demo to talk to it.
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function putAvatar(req, res, agentId) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const looksRight = AVATAR_TYPES[type];
    if (!looksRight) return json(res, 415, { error: 'Send Content-Type: image/png, image/jpeg or image/webp' });
    const body = await readRaw(req, MAX_AVATAR_BYTES);
    if (!looksRight(body)) return json(res, 400, { error: 'The body is not a ' + type + ' file' });
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    avatars.delete(agentId);
    while (avatars.size >= MAX_AVATARS) avatars.delete(avatars.keys().next().value);
    avatars.set(agentId, { type, body, etag });
    return json(res, 201, { ok: true, etag: etag.slice(1, -1) });
  }

  function getAvatar(req, res, agentId) {
    const a = avatars.get(agentId);
    if (!a) return json(res, 404, { error: 'No avatar' });
    const headers = {
      'Content-Type': a.type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=3600',
      ETag: a.etag,
    };
    if (req.headers['if-none-match'] === a.etag) return res.writeHead(304, headers).end();
    res.writeHead(200, { ...headers, 'Content-Length': a.body.length });
    res.end(req.method === 'HEAD' ? undefined : a.body);
  }

  async function serveStatic(req, res) {
    const url = new URL(req.url, 'http://x');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(staticDir, path);
    if (!file.startsWith(staticDir)) return json(res, 403, { error: 'Forbidden' });
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(staticDir, 'index.html');
    }
    try {
      const body = await readFile(file);
      const cache = file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
      res.end(body);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Agent Floor server is running, but the web app is not built.\nRun `npm run build`, or use `npm run dev` while developing.\n');
    }
  }

  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  const server = createServer(async (req, res) => {
    // DNS-rebinding guard: when bound to loopback, only answer loopback hostnames.
    if (loopback && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) {
      return json(res, 403, { error: 'Forbidden host' });
    }
    cors(req, res);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const url = new URL(req.url, 'http://x');
    const { pathname } = url;
    const avatarMatch = /^\/avatars\/([^/]+)$/.exec(pathname);
    // Requiring JSON (or, for pictures, an image type) forces a CORS preflight,
    // so random web pages cannot post "simple" form requests to your floor.
    // curl and the hooks send this header.
    if (req.method === 'POST' && !avatarMatch && !String(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'Send Content-Type: application/json' });
    }

    try {
      if (avatarMatch) {
        let agentId;
        try {
          agentId = decodeURIComponent(avatarMatch[1]);
        } catch {
          agentId = '';
        }
        if (!AGENT_ID_RE.test(agentId)) return json(res, 400, { error: 'Bad agent id' });
        if (req.method === 'POST') return await putAvatar(req, res, agentId);
        if (req.method === 'GET' || req.method === 'HEAD') return getAvatar(req, res, agentId);
        return json(res, 405, { error: 'Method not allowed' });
      }
      if (pathname === '/events' && req.method === 'POST') {
        const body = await readBody(req);
        const list = Array.isArray(body) ? body : [body];
        let accepted = 0;
        for (const raw of list.slice(0, 200)) if (ingest(raw)) accepted++;
        announceWorlds();
        return json(res, accepted ? 202 : 400, { accepted, rejected: list.length - accepted });
      }
      if (pathname === '/worlds' && req.method === 'GET') return json(res, 200, summary());
      if (pathname === '/stream' && req.method === 'GET') {
        const asked = worldParam(url);
        if (asked === null) return json(res, 400, { error: 'Bad world' });
        const id = asked ?? defaultWorld();
        const w = worlds.get(id);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const snapshot = {
          version: PROTOCOL_VERSION,
          state: w ? w.state : createState(),
          world: { id, name: w ? w.name : titleCase(id) },
          worlds: summary(),
        };
        res.write(`retry: 1500\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
        if (!watchers.has(id)) watchers.set(id, new Set());
        watchers.get(id).add(res);
        req.on('close', () => {
          const set = watchers.get(id);
          set?.delete(res);
          if (set && !set.size) watchers.delete(id);
        });
        return;
      }
      if (pathname === '/state' && req.method === 'GET') {
        const asked = worldParam(url);
        if (asked === null) return json(res, 400, { error: 'Bad world' });
        return json(res, 200, worlds.get(asked ?? defaultWorld())?.state ?? createState());
      }
      if (pathname === '/health') {
        let agents = 0;
        for (const w of worlds.values()) agents += Object.keys(w.state.agents).length;
        return json(res, 200, { ok: true, version: PROTOCOL_VERSION, agents });
      }
      if (pathname === '/reset' && req.method === 'POST') {
        const asked = worldParam(url);
        if (asked === null) return json(res, 400, { error: 'Bad world' });
        if (asked === undefined) for (const w of worlds.values()) resetWorld(w);
        else if (worlds.has(asked)) resetWorld(worlds.get(asked));
        announceWorlds();
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET') return serveStatic(req, res);
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message || 'Bad request' });
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log(`Agent Floor is live at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
      resolvePromise({
        server,
        /** The default world's state (what a single-floor setup sees). */
        get state() {
          return worlds.get(defaultWorld())?.state ?? createState();
        },
        worlds,
        ingest,
        close() {
          clearInterval(sweeper);
          clearInterval(heartbeat);
          for (const set of watchers.values()) for (const res of set) res.end();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? 'Port is already in use. Set AGENT_FLOOR_PORT to pick another.' : err);
    process.exit(1);
  });
}
