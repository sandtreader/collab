// Client handshake and ordering logic, driven through a fake socket so the
// test controls exactly which messages arrive and when.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CollabClient } from "../src/client/index.js";
import type { Message, Payload } from "../src/protocol/index.js";
import { MemoryDocument } from "./helpers.js";

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Message[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = FakeSocket.CLOSED; }
  // test helpers
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  receive(payload: Payload, extra: Partial<Message> = {}) {
    this.onmessage?.({ data: JSON.stringify({ ts: 0, userId: "", sessionId: "s", payload, ...extra }) });
  }
  lastSent() { return this.sent[this.sent.length - 1]; }
  sentTypes() { return this.sent.map((m) => m.payload.type); }
}

function makeClient(doc: MemoryDocument) {
  let n = 0;
  return new CollabClient({
    app: "test",
    userId: "me",
    displayName: "Me",
    document: doc,
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    generateId: () => `cid${++n}`,
    snapshotTimeoutMs: 50,
    snapshotRetries: 2,
  });
}

describe("CollabClient handshake", () => {
  beforeEach(() => { FakeSocket.instances = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("connects to <server>?app=<app> and joins", () => {
    const client = makeClient(new MemoryDocument());
    client.connect("abc", "ws://relay:1/collab");
    const ws = FakeSocket.instances[0];
    expect(ws.url).toBe("ws://relay:1/collab?app=test");
    expect(client.status).toBe("connecting");
    ws.open();
    expect(client.status).toBe("joining");
    expect(ws.sentTypes()).toEqual(["join"]);
  });

  it("is connected immediately when first in the session", () => {
    const doc = new MemoryDocument();
    const client = makeClient(doc);
    client.connect("abc", "ws://relay:1");
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.receive({ type: "session_info", members: {}, seq: 7 });
    expect(client.status).toBe("connected");
    expect(client.lastSeq).toBe(7);
    expect(doc.snapshots).toBe(0);
    expect(ws.sentTypes()).toEqual(["join"]);
  });

  it("requests a snapshot when others are present and applies it", () => {
    const doc = new MemoryDocument();
    const client = makeClient(doc);
    client.connect("abc", "ws://relay:1");
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.receive({ type: "session_info", members: { other: "Other" }, seq: 3 });
    expect(client.status).toBe("joining");
    expect(ws.sentTypes()).toEqual(["join", "snapshot_request"]);
    expect([...client.users.entries()]).toEqual([["me", "Me"], ["other", "Other"]]);

    ws.receive({ type: "snapshot_response", state: { entities: { e: { kind: "k", props: { v: 1 } } } }, seq: 3 });
    expect(client.status).toBe("connected");
    expect(doc.state.entities.e.props.v).toBe(1);
  });

  it("buffers changes during joining and replays only those after the snapshot", () => {
    const doc = new MemoryDocument();
    const client = makeClient(doc);
    client.connect("abc", "ws://relay:1");
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.receive({ type: "session_info", members: { other: "Other" }, seq: 3 });

    // Two changes arrive before the snapshot: seq 4 is inside it, seq 5 is not.
    ws.receive({ type: "props_changed", id: "e", props: { v: 4 } }, { seq: 4, userId: "other" });
    ws.receive({ type: "props_changed", id: "e", props: { v: 5 } }, { seq: 5, userId: "other" });
    expect(doc.applied).toHaveLength(0);

    ws.receive({ type: "snapshot_response", state: { entities: { e: { kind: "k", props: { v: 4 } } } }, seq: 4 });
    expect(client.status).toBe("connected");
    expect(doc.applied).toHaveLength(1);
    expect(doc.state.entities.e.props.v).toBe(5);
    expect(client.lastSeq).toBe(5);
  });

  it("retries the snapshot request and finally gives up", () => {
    const client = makeClient(new MemoryDocument());
    client.connect("abc", "ws://relay:1");
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.receive({ type: "session_info", members: { other: "Other" }, seq: 0 });
    expect(ws.sentTypes()).toEqual(["join", "snapshot_request"]);
    vi.advanceTimersByTime(60);
    expect(ws.sentTypes()).toEqual(["join", "snapshot_request", "snapshot_request"]);
    expect(client.status).toBe("joining");
    vi.advanceTimersByTime(60);
    expect(client.status).toBe("connected");
  });

  it("answers snapshot requests only once connected", () => {
    const doc = new MemoryDocument();
    doc.state = { entities: { x: { kind: "k", props: {} } } };
    const client = makeClient(doc);
    client.connect("abc", "ws://relay:1");
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.receive({ type: "snapshot_request" }, { userId: "other" });
    expect(ws.sentTypes()).toEqual(["join"]);   // still joining: ignored
    ws.receive({ type: "session_info", members: {}, seq: 2 });
    ws.receive({ type: "snapshot_request" }, { userId: "other" });
    const last = ws.lastSent();
    expect(last.payload).toEqual({ type: "snapshot_response", state: doc.state, seq: 2 });
  });

  it("reconnects with backoff after an unexpected close", () => {
    const client = makeClient(new MemoryDocument());
    client.connect("abc", "ws://relay:1");
    const ws1 = FakeSocket.instances[0];
    ws1.open();
    ws1.receive({ type: "session_info", members: {}, seq: 0 });
    ws1.onclose?.();
    expect(client.status).toBe("connecting");
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].open();
    expect(FakeSocket.instances[1].sentTypes()).toEqual(["join"]);
  });

  it("disconnect clears session state and does not reconnect", () => {
    const client = makeClient(new MemoryDocument());
    client.connect("abc", "ws://relay:1");
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.receive({ type: "session_info", members: { o: "O" }, seq: 0 });
    client.disconnect();
    expect(client.status).toBe("disconnected");
    expect(client.sessionId).toBeNull();
    expect(client.users.size).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("CollabClient ordering", () => {
  let doc: MemoryDocument;
  let client: CollabClient;
  let ws: FakeSocket;

  beforeEach(() => {
    FakeSocket.instances = [];
    doc = new MemoryDocument();
    doc.state = { entities: { e: { kind: "k", props: { w: 0, h: 0 } } } };
    client = makeClient(doc);
    client.connect("abc", "ws://relay:1");
    ws = FakeSocket.instances[0];
    ws.open();
    ws.receive({ type: "session_info", members: { other: "Other" }, seq: 0 });
    ws.receive({ type: "snapshot_response", state: doc.state, seq: 0 });
    ws.sent = [];
  });

  it("sends local changes with a cid and drops the echo without re-applying", () => {
    client.send(doc.local({ type: "props_changed", id: "e", props: { w: 10 } }));
    const sent = ws.lastSent();
    expect(sent.cid).toBe("cid1");
    expect(sent.payload.type).toBe("props_changed");

    ws.receive(sent.payload, { userId: "me", cid: "cid1", seq: 1 });
    expect(doc.applied).toHaveLength(0);
    expect(client.lastSeq).toBe(1);
  });

  it("applies remote changes through the document inside suppress()", () => {
    let suppressedDuringApply: boolean | undefined;
    doc.applyChange = (c) => { suppressedDuringApply = client.suppressed; doc.state = { ...doc.state }; doc.applied.push(c); };
    ws.receive({ type: "props_changed", id: "e", props: { w: 5 } }, { userId: "other", seq: 1 });
    expect(suppressedDuringApply).toBe(true);
    expect(client.suppressed).toBe(false);
    expect(doc.applied).toHaveLength(1);
  });

  it("does not send while suppressed", () => {
    client.suppress(() => client.send({ type: "entity_removed", id: "e" }));
    expect(ws.sent).toHaveLength(0);
  });

  it("local pending value wins over a conflicting remote until the echo arrives", () => {
    // Server order: remote w=20 (seq 1), then ours w=10 (seq 2).
    client.send(doc.local({ type: "props_changed", id: "e", props: { w: 10 } }));
    const mine = ws.lastSent();

    ws.receive({ type: "props_changed", id: "e", props: { w: 20, h: 7 } }, { userId: "other", seq: 1 });
    // w masked (pending), h applied
    expect(doc.state.entities.e.props).toEqual({ w: 10, h: 7 });

    ws.receive(mine.payload, { userId: "me", cid: mine.cid, seq: 2 });
    expect(doc.state.entities.e.props.w).toBe(10);

    // Pending released: a later remote w now applies.
    ws.receive({ type: "props_changed", id: "e", props: { w: 30 } }, { userId: "other", seq: 3 });
    expect(doc.state.entities.e.props.w).toBe(30);
  });

  it("server order wins when the echo comes first", () => {
    // Server order: ours w=10 (seq 1), then remote w=20 (seq 2).
    client.send(doc.local({ type: "props_changed", id: "e", props: { w: 10 } }));
    const mine = ws.lastSent();
    ws.receive(mine.payload, { userId: "me", cid: mine.cid, seq: 1 });
    ws.receive({ type: "props_changed", id: "e", props: { w: 20 } }, { userId: "other", seq: 2 });
    expect(doc.state.entities.e.props.w).toBe(20);
  });

  it("masks inside batches and drops fully-masked changes", () => {
    client.send(doc.local({ type: "props_changed", id: "e", props: { w: 1, h: 1 } }));
    ws.receive({ type: "batch", changes: [
      { type: "props_changed", id: "e", props: { w: 9 } },
      { type: "entity_added", id: "n", kind: "k", props: {} },
    ] }, { userId: "other", seq: 1 });
    expect(doc.applied).toEqual([{ type: "batch", changes: [{ type: "entity_added", id: "n", kind: "k", props: {} }] }]);
    expect(doc.state.entities.e.props.w).toBe(1);

    ws.receive({ type: "props_changed", id: "e", props: { h: 9 } }, { userId: "other", seq: 2 });
    expect(doc.applied).toHaveLength(1);   // fully masked: nothing applied
  });

  it("tracks presence with display names and clears it on leave", () => {
    const seen: unknown[] = [];
    client.onPresence((p) => seen.push(p));
    ws.receive({ type: "presence", userId: "other", cursor: [1, 2] });
    expect(client.presence).toEqual([{ userId: "other", displayName: "Other", cursor: [1, 2], selection: undefined }]);
    ws.receive({ type: "leave", userId: "other" });
    expect(client.presence).toEqual([]);
    expect(client.users.has("other")).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it("only sends presence when connected", () => {
    client.sendPresence({ cursor: [3, 4] });
    expect(ws.lastSent().payload).toEqual({ type: "presence", userId: "me", cursor: [3, 4] });
  });
});
