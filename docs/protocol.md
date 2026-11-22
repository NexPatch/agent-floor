# Event protocol (v1)

Agents talk to the floor by posting JSON to `POST /events`. Send one object or an array of up to 200. The request must have `Content-Type: application/json`.

Only `type` and `agent` are required. Any event creates the agent and its team if they do not exist yet, so the smallest useful integration is a single `status` call.

```json
{ "type": "status", "agent": "bot-1", "team": "Payments", "status": "working", "activity": "Reconciling invoices" }
```

## Fields

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `join` `status` `tool` `message` `task` `leave` `reset` | What happened. |
| `agent` | string, or `{ id, name?, role?, source? }` | Stable id for this agent. Reuse it for every event. |
| `name` | string | Display name. Defaults to a tidied version of the id. |
| `role` | string | Shown under the name and decides shirt colour. `Lead` gets the head desk and a headset. |
| `team` | string, or `{ id?, name }` | The room. Agents with the same team share a square. Defaults to the parent's team, then `default`. |
| `parent` | agent id | Who spawned this agent. Joining with a parent plays a briefing paper plane. |
| `source` | string | `claude-code`, `codex`, `cursor`, `cli` or anything you like. Shown on the agent card. |
| `status` | `idle` `thinking` `working` `waiting` `done` `error` `offline` | Drives the character's pose, badge, screen and floor ring. |
| `activity` | string, up to 280 chars | One line about what it is doing right now. Shown on the monitor and the name tag. |
| `tool` | string | Tool name for `tool` events. Shown in the monitor's title bar. |
| `to` | agent id or array | Recipients of a `message`. Unknown recipients are created in the sender's team. |
| `text` | string | Message text, shown in a speech bubble over the sender. |
| `task` | string | For `task` events: written on the team whiteboard. |
| `subagent` | `{ key?, type? }` | For adapters that only know "a subagent of type X". See below. |
| `world` | slug: `a-z`, `0-9`, `-`, up to 40 | The world (for example an organization) the event belongs to. Each world is a floor of its own. Defaults to `default`. An event with an invalid `world` is rejected. |
| `worldName` | string, up to 80 chars | Display name of the world, shown in the page's organization menu. Defaults to a tidied version of the slug. |
| `avatar` | `A-Z`, `a-z`, `0-9`, up to 64 | A short hash of the picture posted to `/avatars/<agent>` (see below). The page shows the picture on the agent card, the name tag and as a round badge above the character. Anything else is ignored. |
| `ts` | number (ms) | Optional timestamp. Defaults to now. |

## Event types

- **join**: an agent arrives. It walks in from the door and sits down. With `parent`, the parent briefs it.
- **status**: change `status` and/or `activity`.
- **tool**: the agent is using a tool. Sets `status` to `working` unless you pass another.
- **message**: a paper plane flies from `agent` to each `to`. Without `to`, it goes to the parent.
- **task**: update the team whiteboard.
- **leave**: the agent stands up and walks out. It is removed a few seconds later.
- **reset**: clear the floor of the event's world (`default` without `world`).

## Lifetime

The server forgets agents that have left after 6 seconds, helpers (agents with a `parent`) 45 seconds after they finish with `done`, and anything silent for 2 hours. Empty rooms disappear with their last agent.

## Subagent hints

Some tools tell you a tool call happened inside "a subagent of type `code-reviewer`" with an opaque id, but not which spawn it belongs to. Send the event as the parent with a hint:

```json
{ "type": "tool", "agent": "lead-1", "subagent": { "key": "ag_9", "type": "code-reviewer" }, "tool": "Read", "activity": "Reading cart.ts" }
```

The floor binds the hint to the oldest unbound helper of that `role` under `lead-1`, and remembers the key so later events land on the same desk. If there is no such helper, it opens a new desk.

## Worlds

One server can hold several floors, one per **world** (for example one per organization). Events name their world with `world`; without it they go to `default`, so a setup that never sends `world` has one floor, as before, and the page shows no organization menu.

- At most 16 worlds exist at a time. Events that would open a 17th are rejected.
- A world other than `default` disappears when its last agent is gone.
- Agent ids are global: two worlds must not share one.
- `?world=<slug>` selects a world in the endpoints below; `?org=<slug>` is an alias. Without it, `/stream` and `/state` use `default` while it has agents, otherwise the first world that has any.

## Avatars

An agent can carry a picture of its own:

1. `POST /avatars/<agent id>` with the image as the raw body and `Content-Type: image/png`, `image/jpeg` or `image/webp`. At most 64 KB; the bytes must match the type. The agent id may hold `A-Z a-z 0-9 . _ : -`, up to 128.
2. Send events with `avatar` set to a short hash of the picture. When the picture changes, change the hash: the page loads `/avatars/<agent id>?v=<hash>`.

`GET /avatars/<agent id>` serves the picture with its type, `X-Content-Type-Options: nosniff`, an `ETag` and `Cache-Control: private, max-age=3600`. Pictures are kept in memory; past 512 the oldest is dropped. A reset does not remove them.

## Reading state

- `GET /stream?world=`: Server-Sent Events for one world. First a `snapshot` (`{ version, state, world: { id, name }, worlds }`), then `event` frames (`{ event, effects }`), `removed` frames (`{ agents: [...] }`) and, whenever the list of worlds, their sizes or attention flags change, `worlds` frames (`{ worlds: [...] }`).
- `GET /state?world=`: that world as JSON.
- `GET /worlds`: `[{ id, name, agents, attention }]`, in the order the worlds appeared. `attention` is true while any agent of the world is `waiting` or `error`.
- `GET /health`: `{ ok, version, agents }` (agents of all worlds).
- `POST /reset?world=`: clear one world; without `world`, clear every world.

## The page

- `?org=<slug>` (alias `?world=`) opens the floor on that world. Picking another organization in the menu at the top reconnects to it and writes `?org=` into the address, so the link opens there again. The menu only appears when there is more than one world.
- `?kiosk` hides the menu and the tools, for a wall screen or a demo; the organization's name stays next to the brand.
- `?server=<url>` reads the stream from another server.

The reducer that turns events into state is `shared/protocol.js`. It has no dependencies, so you can import it to build other views on the same stream.
