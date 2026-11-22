import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.mjs';

test('server accepts events and serves state', async () => {
  const floor = await startServer({ port: 0, log: () => {} });
  const { port } = floor.server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ type: 'join', agent: 'a', team: 'T' }, { type: 'bogus' }]),
    });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 1, rejected: 1 });
    const state = await (await fetch(`${base}/state`)).json();
    assert.ok(state.agents.a);

    const bad = await fetch(`${base}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);

    const simple = await fetch(`${base}/events`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"type":"join","agent":"x"}' });
    assert.equal(simple.status, 415, 'non-JSON posts are refused');
  } finally {
    await floor.close();
  }
});

const post = (base, path, body, type = 'application/json') =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(body) : body });

test('worlds keep organizations apart', async () => {
  const floor = await startServer({ port: 0, log: () => {} });
  const base = `http://127.0.0.1:${floor.server.address().port}`;
  try {
    const res = await post(base, '/events', [
      { type: 'join', agent: 'a', team: 'Ops', world: 'nexpatch', worldName: 'NexPatch' },
      { type: 'status', agent: 'b', team: 'Steuer', world: 'kanzlei-musterfrau', worldName: 'Kanzlei Musterfrau', status: 'waiting' },
      { type: 'join', agent: 'c', world: 'Not A Slug' },
      { type: 'join', agent: 'd', world: 'x'.repeat(41) },
    ]);
    assert.deepEqual(await res.json(), { accepted: 2, rejected: 2 });
    assert.deepEqual(await (await fetch(`${base}/worlds`)).json(), [
      { id: 'nexpatch', name: 'NexPatch', agents: 1, attention: false },
      { id: 'kanzlei-musterfrau', name: 'Kanzlei Musterfrau', agents: 1, attention: true },
    ]);
    const k = await (await fetch(`${base}/state?org=kanzlei-musterfrau`)).json();
    assert.deepEqual(Object.keys(k.agents), ['b']);
    // Without a world: the first world that has anyone.
    assert.deepEqual(Object.keys((await (await fetch(`${base}/state`)).json()).agents), ['a']);
    assert.equal((await fetch(`${base}/state?world=Bad!`)).status, 400);
    assert.equal((await (await fetch(`${base}/health`)).json()).agents, 2);

    await post(base, '/reset?world=nexpatch', {});
    assert.deepEqual((await (await fetch(`${base}/state?world=nexpatch`)).json()).agents, {});
    assert.ok((await (await fetch(`${base}/state?world=kanzlei-musterfrau`)).json()).agents.b);
    await post(base, '/reset', {});
    assert.deepEqual((await (await fetch(`${base}/state?world=kanzlei-musterfrau`)).json()).agents, {});
  } finally {
    await floor.close();
  }
});

test('the number of worlds is capped', async () => {
  const floor = await startServer({ port: 0, log: () => {} });
  const base = `http://127.0.0.1:${floor.server.address().port}`;
  try {
    const events = Array.from({ length: 20 }, (_, i) => ({ type: 'join', agent: `a${i}`, world: `w${i}` }));
    assert.deepEqual(await (await post(base, '/events', events)).json(), { accepted: 16, rejected: 4 });
    assert.equal((await (await fetch(`${base}/worlds`)).json()).length, 16);
  } finally {
    await floor.close();
  }
});

test('stream sends only its world', async () => {
  const floor = await startServer({ port: 0, log: () => {} });
  const base = `http://127.0.0.1:${floor.server.address().port}`;
  const ctrl = new AbortController();
  try {
    const res = await fetch(`${base}/stream?org=two`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    let text = '';
    const until = async (needle) => {
      while (!text.includes(needle)) text += new TextDecoder().decode((await reader.read()).value);
    };
    await until('event: snapshot');
    await post(base, '/events', { type: 'join', agent: 'one-agent', world: 'one' });
    await post(base, '/events', { type: 'join', agent: 'two-agent', world: 'two', worldName: 'Two' });
    await until('two-agent');
    await until('event: worlds');
    assert.ok(!text.includes('"agent":"one-agent"'), 'events of another world never reach this stream');
  } finally {
    ctrl.abort();
    await floor.close();
  }
});

test('avatars: images only, bounded, served with their type', async () => {
  const floor = await startServer({ port: 0, log: () => {} });
  const base = `http://127.0.0.1:${floor.server.address().port}`;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  try {
    assert.equal((await post(base, '/avatars/aos-agent-1', png, 'image/png')).status, 201);
    const got = await fetch(`${base}/avatars/aos-agent-1`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await got.arrayBuffer()).equals(png));
    const again = await fetch(`${base}/avatars/aos-agent-1`, { headers: { 'If-None-Match': got.headers.get('etag') } });
    assert.equal(again.status, 304);

    assert.equal((await post(base, '/avatars/x', '<svg/>', 'image/svg+xml')).status, 415, 'no SVG');
    assert.equal((await post(base, '/avatars/x', png, 'image/jpeg')).status, 400, 'bytes must match the type');
    assert.equal((await post(base, '/avatars/x', Buffer.concat([png, Buffer.alloc(64 * 1024)]), 'image/png')).status, 413);
    assert.equal((await post(base, '/avatars/a%2Fb', png, 'image/png')).status, 400);
    assert.equal((await fetch(`${base}/avatars/nobody`)).status, 404);

    for (let i = 0; i < 520; i++) await post(base, `/avatars/a${i}`, png, 'image/png');
    assert.equal((await fetch(`${base}/avatars/aos-agent-1`)).status, 404, 'the oldest is dropped past the cap');
    assert.equal((await fetch(`${base}/avatars/a519`)).status, 200);

    await post(base, '/events', { type: 'join', agent: 'aos-agent-1', avatar: 'abc123' });
    await post(base, '/events', { type: 'status', agent: 'aos-agent-2', avatar: '../evil' });
    const s = await (await fetch(`${base}/state`)).json();
    assert.equal(s.agents['aos-agent-1'].avatar, 'abc123');
    assert.equal(s.agents['aos-agent-2'].avatar, undefined);
  } finally {
    await floor.close();
  }
});
