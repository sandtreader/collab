// End to end: real relay, real sockets (Node's built-in WebSocket client),
// two or three CollabClients converging on one document.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createRelay, appFromUrl, type Relay } from "../src/server/index.js";
import { CollabClient } from "../src/client/index.js";
import { MemoryDocument, waitFor, sleep } from "./helpers.js";

let relay: Relay;
let url: string;
const clients: CollabClient[] = [];

beforeAll(async () => {
  relay = createRelay({ port: 0 });
  await waitFor(() => relay.port() !== undefined, 2000, "relay to listen");
  url = `ws://127.0.0.1:${relay.port()}`;
});

afterAll(async () => { await relay.close(); });
afterEach(() => { for (const c of clients) c.disconnect(); clients.length = 0; });

function join(app: string, session: string, userId: string, doc = new MemoryDocument()) {
  const client = new CollabClient({ app, userId, displayName: userId.toUpperCase(), document: doc, snapshotTimeoutMs: 500 });
  clients.push(client);
  client.connect(session, url);
  return { client, doc };
}

describe("relay + client", () => {
  it("first member connects without a snapshot; second gets one", async () => {
    const a = join("app", "s1", "a");
    a.doc.state = { entities: { r: { kind: "rect", props: { w: 1 } } } };
    await waitFor(() => a.client.status === "connected", 2000, "a connected");
    expect(a.doc.snapshots).toBe(0);

    const b = join("app", "s1", "b");
    await waitFor(() => b.client.status === "connected", 2000, "b connected");
    expect(b.doc.snapshots).toBe(1);
    expect(b.doc.state.entities.r.props.w).toBe(1);
    expect([...b.client.users.keys()].sort()).toEqual(["a", "b"]);
    await waitFor(() => a.client.users.has("b"), 1000, "a sees b");
    expect(a.client.users.get("b")).toBe("B");
    expect(relay.members("app", "s1")).toEqual({ a: "A", b: "B" });
  });

  it("stamps seq, echoes to sender, and delivers to others", async () => {
    const a = join("app", "s2", "a");
    await waitFor(() => a.client.status === "connected");
    const b = join("app", "s2", "b");
    await waitFor(() => b.client.status === "connected");

    a.client.send(a.doc.local({ type: "entity_added", id: "e", kind: "k", props: { v: 1 } }));
    await waitFor(() => b.doc.state.entities.e !== undefined, 1000, "b receives add");
    await waitFor(() => a.client.lastSeq === 1, 1000, "a sees echo seq");
    expect(b.client.lastSeq).toBe(1);
    expect(a.doc.applied).toHaveLength(0);   // own change was not re-applied
  });

  it("converges on concurrent edits to the same prop", async () => {
    const a = join("app", "s3", "a");
    await waitFor(() => a.client.status === "connected");
    a.client.send(a.doc.local({ type: "entity_added", id: "e", kind: "k", props: { w: 0 } }));
    const b = join("app", "s3", "b");
    await waitFor(() => b.client.status === "connected" && b.doc.state.entities.e !== undefined);

    // Both edit the same prop before either hears from the other.
    a.client.send(a.doc.local({ type: "props_changed", id: "e", props: { w: 10 } }));
    b.client.send(b.doc.local({ type: "props_changed", id: "e", props: { w: 20 } }));

    await waitFor(() => a.client.lastSeq >= 3 && b.client.lastSeq >= 3, 2000, "both caught up");
    await sleep(50);
    expect(a.doc.state.entities.e.props.w).toBe(b.doc.state.entities.e.props.w);
    expect([10, 20]).toContain(a.doc.state.entities.e.props.w);
  });

  it("broadcasts presence and leave", async () => {
    const a = join("app", "s4", "a");
    await waitFor(() => a.client.status === "connected");
    const b = join("app", "s4", "b");
    await waitFor(() => b.client.status === "connected");
    await waitFor(() => a.client.users.has("b"));

    b.client.sendPresence({ cursor: [5, 6], selection: ["x"] });
    await waitFor(() => a.client.presence.length === 1, 1000, "a sees presence");
    expect(a.client.presence[0]).toMatchObject({ userId: "b", displayName: "B", cursor: [5, 6], selection: ["x"] });

    b.client.disconnect();
    await waitFor(() => !a.client.users.has("b"), 1000, "a sees leave");
    expect(a.client.presence).toEqual([]);
  });

  it("keeps apps apart even with the same session id", async () => {
    const a = join("one", "same", "a");
    await waitFor(() => a.client.status === "connected");
    const b = join("two", "same", "b");
    await waitFor(() => b.client.status === "connected");
    expect(b.doc.snapshots).toBe(0);
    expect(b.client.users.has("a")).toBe(false);
    expect(relay.sessionCount()).toBe(2);
  });

  it("routes the snapshot only to the requester", async () => {
    const a = join("app", "s6", "a");
    await waitFor(() => a.client.status === "connected");
    const b = join("app", "s6", "b");
    await waitFor(() => b.client.status === "connected");
    const c = join("app", "s6", "c");
    await waitFor(() => c.client.status === "connected");
    // b never joined again, so it must not have been handed a second snapshot
    expect(b.doc.snapshots).toBe(1);
    expect(c.doc.snapshots).toBe(1);
  });

  it("still keeps apps apart when the relay sits behind a path prefix", async () => {
    // e.g. nginx `location /collab { proxy_pass http://relay; }` leaves the prefix in place
    const a = join("one", "pfx", "a");
    await waitFor(() => a.client.status === "connected");
    const direct = new CollabClient({ app: "one", userId: "b", displayName: "B", document: new MemoryDocument() });
    clients.push(direct);
    direct.connect("pfx", `${url}/collab/deeper`);
    await waitFor(() => direct.status === "connected");
    expect(direct.users.has("a")).toBe(true);
  });

  it("resolves the app namespace from query, then last path segment, then fallback", () => {
    expect(appFromUrl("/?app=synflo", "d")).toBe("synflo");
    expect(appFromUrl("/collab?app=synflo", "d")).toBe("synflo");
    expect(appFromUrl("/collab/synflo", "d")).toBe("synflo");
    expect(appFromUrl("/synflo", "d")).toBe("synflo");
    expect(appFromUrl("/", "d")).toBe("d");
    expect(appFromUrl(undefined, "d")).toBe("d");
  });

  it("closes a socket whose first message is not a join", async () => {
    const ws = new WebSocket(`${url}/app`);
    const closed = new Promise<number>((resolve) => { ws.onclose = (e) => resolve(e.code); });
    await new Promise<void>((r) => { ws.onopen = () => r(); });
    ws.send(JSON.stringify({ ts: 0, userId: "x", sessionId: "s7", payload: { type: "presence", userId: "x" } }));
    expect(await closed).toBe(4000);
  });
});
