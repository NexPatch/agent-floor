import { createScript } from '../../shared/demo-script.js';
import { createState, worldId } from '../../shared/protocol.js';
import type { Effect, FloorEvent, WorldState, WorldSummary } from '../../shared/protocol';
import { store } from './store';
import { DEMO_ONLY } from '../config';
import { serverBase } from './server';

const params = new URLSearchParams(location.search);

/**
 * The world (organization) asked for: `?org=<slug>`, or its alias `?world=`.
 * Null lets the server pick (the default world, else the first one).
 */
function askedWorld() {
  const raw = params.get('org') ?? params.get('world');
  return raw ? worldId(raw) : null;
}

let chosen: string | null = askedWorld();
let source: EventSource | null = null;
let opened = false;
let fallback: number | undefined;

let demoTimer: number | undefined;
let sweepTimer: number | undefined;
let demoRunning = false;

export function startDemo() {
  if (demoRunning) return;
  demoRunning = true;
  store.replace({ teams: {}, agents: {}, seq: 0, updatedAt: Date.now() });
  store.setMode('demo');
  const script = createScript();
  const step = () => {
    const { wait, events } = script.next();
    for (const ev of events) store.applyLocal({ ...ev, ts: Date.now() });
    demoTimer = window.setTimeout(step, wait);
  };
  step();
  sweepTimer = window.setInterval(() => store.sweepLocal(), 2000);
}

export function stopDemo() {
  if (!demoRunning) return;
  demoRunning = false;
  window.clearTimeout(demoTimer);
  window.clearInterval(sweepTimer);
}

export function isDemoRunning() {
  return demoRunning;
}

export function connect() {
  if (params.has('demo') || (DEMO_ONLY && !params.has('server'))) {
    startDemo();
    return;
  }
  // Without a reachable server (hosted demo, floor not started) show the demo
  // after a moment, but keep retrying so a live floor takes over when it appears.
  fallback = window.setTimeout(() => {
    if (!opened) startDemo();
  }, 2200);
  open();
}

function open() {
  const q = chosen ? `?world=${encodeURIComponent(chosen)}` : '';
  const es = new EventSource(`${serverBase()}/stream${q}`);
  source = es;
  es.addEventListener('snapshot', (msg) => {
    if (es !== source) return;
    opened = true;
    window.clearTimeout(fallback);
    stopDemo();
    const { state, world, worlds } = JSON.parse((msg as MessageEvent).data) as {
      state: WorldState;
      world?: { id: string; name: string };
      worlds?: WorldSummary[];
    };
    store.replace(state);
    store.setWorlds(worlds || [], world || null);
    store.setMode('live');
  });
  es.addEventListener('event', (msg) => {
    if (demoRunning || es !== source) return;
    const { event, effects } = JSON.parse((msg as MessageEvent).data) as { event: FloorEvent; effects: Effect[] };
    store.applyRemote(event, effects);
  });
  es.addEventListener('removed', (msg) => {
    if (demoRunning || es !== source) return;
    store.remove((JSON.parse((msg as MessageEvent).data) as { agents: string[] }).agents);
  });
  es.addEventListener('worlds', (msg) => {
    if (demoRunning || es !== source) return;
    const { worlds } = JSON.parse((msg as MessageEvent).data) as { worlds: WorldSummary[] };
    store.setWorlds(worlds);
    // Nobody picked a world and the one the server gave us is gone while
    // others exist (an organization started posting): follow the server.
    const current = store.world?.id;
    if (!chosen && current && worlds.length && !worlds.some((w) => w.id === current)) reconnect();
  });
  es.onerror = () => {
    if (es !== source) return;
    if (!demoRunning && opened) store.setMode('connecting');
    // EventSource retries on its own while the server answers with errors;
    // if it gives up (CLOSED) we retry after a pause.
    if (es.readyState === EventSource.CLOSED) {
      window.setTimeout(() => {
        if (es === source) open();
      }, 3000);
    }
  };
}

function reconnect() {
  source?.close();
  source = null;
  store.setMode('connecting');
  store.replace(createState());
  open();
}

/** Show another world: reconnect the stream to it and keep the choice in the URL (`?org=`). */
export function switchWorld(id: string) {
  if (demoRunning || (id === chosen && id === store.world?.id)) return;
  chosen = id;
  const url = new URL(location.href);
  url.searchParams.delete('world');
  url.searchParams.set('org', id);
  history.replaceState(null, '', url);
  store.select(null);
  store.setWorlds(store.worlds, { id, name: store.worlds.find((w) => w.id === id)?.name || id });
  reconnect();
}
