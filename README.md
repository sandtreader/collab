# @sandtreader/collab

Model-agnostic real-time collaboration for browser apps. Extracted from
[SynFlo](https://github.com/vigraph/synflo) and generalised so that any app
whose document is a set of entities with properties can share it.

- **Entity document.** A flat map of `{ kind, props }` by ID. No graph, no
  schema: the app decides what the kinds and props mean.
- **Sequenced relay.** A stateless WebSocket server that stamps every change
  with a per-session sequence number and echoes it to everyone, including
  the sender. One total order per session, so concurrent edits converge.
- **Framework-free client.** Join handshake, snapshots, reconnect with
  backoff, presence, and the optimistic-edit logic. Talks to your model
  through a three-method adapter.
- **React session UI.** Drop-in panel for display name, join by ID, share
  link and QR code, member list; plus remote cursors.

## Install

```bash
pnpm add @sandtreader/collab
```

The server entry needs `ws`. The React entry needs `react`, `@mui/material`,
`@mui/icons-material`, `@emotion/react`, `@emotion/styled`, `qrcode.react`
and `bad-words`. All are optional peer dependencies: install only what you
use.

## Entries

| Import | Contents |
|---|---|
| `@sandtreader/collab/protocol` | Types, `applyChange` and friends. No dependencies. |
| `@sandtreader/collab/client` | `CollabClient`. No dependencies. |
| `@sandtreader/collab/server` | `createRelay`. Needs `ws`. |
| `@sandtreader/collab/react` | `SessionPanel`, `RemoteCursors`, `useCollab`, identity and session-ID helpers. |

## The protocol

```ts
type Change =
  | { type: "entity_added";   id: string; kind: string; props: Props }
  | { type: "entity_removed"; id: string }
  | { type: "props_changed";  id: string; props: Props;        // shallow merge; null deletes
      gestureStart?: boolean; gestureEnd?: boolean; transient?: boolean }
  | { type: "batch";          changes: Change[] }               // one unit, e.g. an undo group
  | { type: "state_replaced"; state: DocState };                // "open file" while connected
```

Convergence rules, implemented once in `applyChange` and relied on by every
client:

- `entity_added` on an existing ID replaces the entity.
- `props_changed` or `entity_removed` on an unknown ID is ignored.
- `props_changed` is a shallow merge; a `null` value deletes the key.
- `batch` applies in order. `state_replaced` discards everything.

Presence (`cursor` in model coordinates, `selection` as entity IDs) is
broadcast but never sequenced or stored.

## Using the client

Your app keeps one place where every mutation goes, local or remote. A
local mutation applies itself, then calls `client.send(change)`. Remote
changes come back through the adapter, wrapped in `suppress()` so they don't
echo.

```ts
import { CollabClient } from "@sandtreader/collab/client";
import { applyChange, type DocState } from "@sandtreader/collab/protocol";

let doc: DocState = { entities: {} };

const client = new CollabClient({
  app: "myapp",
  userId, displayName,
  document: {
    getSnapshot: () => doc,
    applySnapshot: (s) => { doc = s; render(); },
    applyChange: (c) => { doc = applyChange(doc, c); render(); },
  },
});

function setWidth(id: string, width: number) {
  const change = { type: "props_changed", id, props: { width } } as const;
  doc = applyChange(doc, change);
  render();
  client.send(change);          // no-op while suppressed or disconnected
}

client.connect("abc-defg-hij", "wss://relay.example.com");
```

The first member's local document becomes the session state. Later joiners
receive a snapshot from an existing member, with any changes that arrived
during the handshake replayed in order.

Throttle continuous edits yourself (drags at ~50 ms, presence at ~100 ms)
and flush the final value with `gestureEnd: true`.

### How conflicts resolve

Local edits are applied optimistically and tracked until the server echoes
them. While a local edit to `(entity, prop)` is pending, a remote edit to
the same pair is ignored; when the echo arrives, the server order is
authoritative and every client has the same value. Independent props never
conflict.

## Running the relay

A shared instance runs at `wss://sandtreader.com/collab`. Any app can use it
with its own `app` name; sessions are isolated per app.


```bash
PORT=2901 npx collab-relay
```

or in code:

```ts
import { createRelay } from "@sandtreader/collab/server";
const relay = createRelay({ port: 2901, log: console.log });
```

The client connects to `<serverUrl>?app=<app>`. Sessions are keyed by app and
session ID, so one relay serves several apps without cross-joining. The
query parameter survives any reverse-proxy path mapping; the relay also
accepts the app as the last path segment.

The relay keeps no document state. Phase 2 (planned) has the server apply
changes itself using the same `applyChange`, answer snapshots directly, and
persist sessions.

## React

```tsx
import { SessionPanel, RemoteCursors, useCollab, autoJoinFromUrl,
         getOrCreateUserId, getOrCreateDisplayName } from "@sandtreader/collab/react";

const config = { serverUrl: "wss://relay.example.com", sessionUrlPrefix: "https://myapp.example/s/",
                 storageKeyPrefix: "myapp" };

<SessionPanel client={client} config={config} />

const { presence } = useCollab(client);
<RemoteCursors presence={presence} toScreen={viewport.modelToScreen} />
```

## Development

```bash
pnpm install
pnpm test          # protocol unit tests, client tests on a fake socket, end-to-end against the real relay
pnpm build
```
