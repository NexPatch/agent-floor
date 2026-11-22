# NexPatch fork of Agent Floor

This is NexPatch's fork of [develop212/agent-floor](https://github.com/develop212/agent-floor)
(MIT, unchanged licence). It feeds the floor stack of NexPatch/infra
(`stacks/floor`), where a bridge posts the runs of our AgenticOS organizations.

## Branches

- `main` mirrors upstream and is never changed by us.
- `nexpatch/main` is the reviewed upstream commit
  `c5422bbea7d6d7c814dd8ef60737ccaebef8e6e8`, the base of our work.
- Our changes arrive on `nexpatch/*` branches through pull requests into
  `nexpatch/main`. The image is built from a reviewed commit of `nexpatch/main`.

## What we changed (package version `0.1.0-nexpatch.1`)

**Worlds** (`server/index.mjs`, `shared/protocol.js`). One floor per world,
for us one per organization (NexPatch, Kanzlei Musterfrau). Events carry
`world` (a slug, up to 40) and `worldName` (up to 80); an invalid `world`
rejects the event, a missing one means `default`, so a setup that never sends
`world` behaves as before. New and changed endpoints: `GET /worlds`,
`GET /stream?world=`, `GET /state?world=`, `POST /reset?world=` (without
`world`: every world); `?org=` is an alias of `?world=`. At most 16 worlds; an
empty world other than `default` is dropped.

**Avatars.** `POST /avatars/<agent id>` takes a PNG, JPEG or WebP up to 64 KB
(the bytes must match the declared type), kept in memory, at most 512 (the
oldest goes). `GET /avatars/<agent id>` serves it with its type,
`X-Content-Type-Options: nosniff`, a sandboxing CSP, an ETag and private
caching. Events name the picture with `avatar` (a short hash). The page shows
it on the agent card, the name tag and as a round badge above the generated
character, which stays.

**Page.** An organization menu at the top (only with more than one world)
with agent counts and an attention dot; picking one reconnects the stream and
writes `?org=<slug>` into the address. `?kiosk` hides the menu and tools for a
wall screen or demo and shows the organization's name next to the brand.
`?server=` still works.

Details: [docs/protocol.md](docs/protocol.md).

## Security notes

- Still no authentication of its own. In our stack a Traefik forwardAuth gate
  lets only `GET`/`HEAD` in from outside; `POST` (events, reset, avatars) comes
  only from the bridge on the stack's internal network.
- All new state is in memory and bounded (worlds, pictures, picture size); no
  new dependencies, no outbound calls, nothing from a CDN.
- `POST /avatars` requires an image content type, which (like JSON for
  `/events`) forces a CORS preflight, so other web pages cannot post pictures.
  SVG is not accepted. Names stay escaped in the page.
