// @sandtreader/collab — client
//
// Framework-free. Owns the WebSocket lifecycle (connect, join handshake,
// reconnect with backoff), session membership, presence, and the ordering
// logic that keeps optimistic local edits consistent with the server's
// sequence. Knows nothing about the application's model: it talks to the
// document through the `CollabDocument` adapter.
//
// Contract with the application:
//   - every mutation, local or remote, goes through one place in the app
//   - a local mutation applies itself first, then calls `client.send(change)`
//     unless `client.suppressed` is true
//   - `CollabDocument.applyChange` / `applySnapshot` call that same place;
//     the client wraps those calls in `suppress()` so they don't echo

import {
  isChange,
  isValidMessage,
  type Change,
  type DocState,
  type Message,
  type Payload,
  type Presence,
  type Props,
} from "../protocol/index.js";

export interface CollabDocument {
  getSnapshot(): DocState;
  applySnapshot(state: DocState): void;
  applyChange(change: Change): void;
}

export type CollabStatus = "disconnected" | "connecting" | "joining" | "connected";

export interface RemotePresence {
  userId: string;
  displayName: string;
  cursor?: [number, number];
  selection?: string[];
}

export interface CollabClientOptions {
  /** Namespaces sessions on the relay: connects to `<serverUrl>?app=<app>`. */
  app: string;
  userId: string;
  displayName: string;
  document: CollabDocument;
  /** Injectable for tests / non-browser runtimes. Defaults to the global. */
  WebSocket?: typeof WebSocket;
  /** How long to wait for a snapshot before asking again. Default 3000. */
  snapshotTimeoutMs?: number;
  /** How many times to ask before giving up and using local state. Default 3. */
  snapshotRetries?: number;
  /** Reconnect backoff cap. Default 30000. */
  maxReconnectDelayMs?: number;
  /** Change-ID generator. Defaults to crypto.randomUUID. */
  generateId?: () => string;
  log?: (line: string) => void;
}

type Unsubscribe = () => void;

export class CollabClient {
  private readonly app: string;
  private readonly _userId: string;
  private _displayName: string;
  private readonly document: CollabDocument;
  private readonly WS: typeof WebSocket;
  private readonly snapshotTimeoutMs: number;
  private readonly snapshotRetries: number;
  private readonly maxReconnectDelayMs: number;
  private readonly generateId: () => string;
  private readonly log: (line: string) => void;

  private ws: WebSocket | null = null;
  private serverUrl: string | null = null;
  private _sessionId: string | null = null;
  private _status: CollabStatus = "disconnected";
  private _suppressed = false;
  private _lastSeq = 0;

  private readonly _users = new Map<string, string>();
  private readonly _presence = new Map<string, Omit<RemotePresence, "displayName">>();

  /** Own changes sent but not yet echoed, by cid. */
  private readonly pending = new Map<string, Change>();
  /** Reference counts of (entityId, prop) pairs touched by pending changes. */
  private readonly pendingProps = new Map<string, number>();
  /** Changes received while joining, replayed after the snapshot lands. */
  private joinBuffer: Message[] = [];

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotAttempts = 0;

  private readonly statusListeners = new Set<(s: CollabStatus) => void>();
  private readonly usersListeners = new Set<(u: Map<string, string>) => void>();
  private readonly presenceListeners = new Set<(p: RemotePresence[]) => void>();

  constructor(opts: CollabClientOptions) {
    this.app = opts.app;
    this._userId = opts.userId;
    this._displayName = opts.displayName;
    this.document = opts.document;
    this.WS = opts.WebSocket ?? globalThis.WebSocket;
    this.snapshotTimeoutMs = opts.snapshotTimeoutMs ?? 3000;
    this.snapshotRetries = opts.snapshotRetries ?? 3;
    this.maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 30000;
    this.generateId = opts.generateId ?? (() => crypto.randomUUID());
    this.log = opts.log ?? (() => {});
  }

  // ---- Public state ----

  get status() { return this._status; }
  get sessionId() { return this._sessionId; }
  get userId() { return this._userId; }
  get users(): ReadonlyMap<string, string> { return this._users; }
  get lastSeq() { return this._lastSeq; }
  /** True while a remote change or snapshot is being applied. */
  get suppressed() { return this._suppressed; }
  get connected() { return this._status === "connected"; }

  get displayName() { return this._displayName; }
  set displayName(name: string) {
    this._displayName = name;
    this._users.set(this._userId, name);
    if (this._status === "connected" || this._status === "joining") {
      this.sendPayload({ type: "join", userId: this._userId, displayName: name });
    }
    this.notifyUsers();
  }

  get presence(): RemotePresence[] {
    const out: RemotePresence[] = [];
    for (const [userId, p] of this._presence) {
      out.push({ ...p, displayName: this._users.get(userId) ?? userId });
    }
    return out;
  }

  onStatus(fn: (s: CollabStatus) => void): Unsubscribe {
    this.statusListeners.add(fn);
    return () => { this.statusListeners.delete(fn); };
  }
  onUsers(fn: (u: Map<string, string>) => void): Unsubscribe {
    this.usersListeners.add(fn);
    return () => { this.usersListeners.delete(fn); };
  }
  onPresence(fn: (p: RemotePresence[]) => void): Unsubscribe {
    this.presenceListeners.add(fn);
    return () => { this.presenceListeners.delete(fn); };
  }

  // ---- Connection ----

  connect(sessionId: string, serverUrl: string) {
    this.disconnect();
    this._sessionId = sessionId;
    this.serverUrl = serverUrl;
    this._users.set(this._userId, this._displayName);
    this.notifyUsers();
    this.setStatus("connecting");
    this.openSocket();
  }

  disconnect() {
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this._sessionId = null;
    this.serverUrl = null;
    this.reconnectDelay = 1000;
    this.resetSessionState();
    if (this._status !== "disconnected") this.setStatus("disconnected");
    this.notifyUsers();
    this.notifyPresence();
  }

  private resetSessionState() {
    this._users.clear();
    this._presence.clear();
    this.pending.clear();
    this.pendingProps.clear();
    this.joinBuffer = [];
    this.snapshotAttempts = 0;
    this._lastSeq = 0;
  }

  private clearTimers() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.snapshotTimer) { clearTimeout(this.snapshotTimer); this.snapshotTimer = null; }
  }

  /** `<serverUrl>?app=<app>`: a query parameter survives any reverse-proxy path mapping. */
  private socketUrl(): string {
    const base = this.serverUrl!;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}app=${encodeURIComponent(this.app)}`;
  }

  private openSocket() {
    const ws = new this.WS(this.socketUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      // A reconnect takes a fresh snapshot; anything unacknowledged is gone.
      this.resetSessionState();
      this._users.set(this._userId, this._displayName);
      this.setStatus("joining");
      this.sendPayload({ type: "join", userId: this._userId, displayName: this._displayName });
    };

    ws.onmessage = (event) => {
      let msg: unknown;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (!isValidMessage(msg)) return;
      this.handleMessage(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.snapshotTimer) { clearTimeout(this.snapshotTimer); this.snapshotTimer = null; }
      if (!this._sessionId) return;
      this.setStatus("connecting");
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this._sessionId) this.openSocket();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelayMs);
    };

    ws.onerror = () => { /* onclose follows */ };
  }

  // ---- Join handshake ----

  private requestSnapshot() {
    this.snapshotAttempts++;
    this.sendPayload({ type: "snapshot_request" });
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      if (this._status !== "joining") return;
      if (this.snapshotAttempts < this.snapshotRetries) {
        this.requestSnapshot();
      } else {
        // Nobody answered. Carry on with local state rather than hang.
        this.log("snapshot timed out; continuing with local state");
        this.finishJoin();
      }
    }, this.snapshotTimeoutMs);
  }

  private finishJoin() {
    if (this.snapshotTimer) { clearTimeout(this.snapshotTimer); this.snapshotTimer = null; }
    const buffered = this.joinBuffer;
    this.joinBuffer = [];
    this.setStatus("connected");
    for (const m of buffered) this.handleMessage(m);
  }

  // ---- Incoming ----

  private handleMessage(msg: Message) {
    const p = msg.payload;

    if (isChange(p)) {
      this.handleChange(msg, p);
      return;
    }

    switch (p.type) {
      case "session_info":
        for (const [id, name] of Object.entries(p.members)) this._users.set(id, name);
        this._lastSeq = p.seq;
        this.notifyUsers();
        if (Object.keys(p.members).length === 0) {
          this.finishJoin();   // first member: local state is the session state
        } else {
          this.requestSnapshot();
        }
        break;

      case "join":
        this._users.set(p.userId, p.displayName);
        this.notifyUsers();
        break;

      case "leave":
        this._users.delete(p.userId);
        this._presence.delete(p.userId);
        this.notifyUsers();
        this.notifyPresence();
        break;

      case "snapshot_request":
        // Only answer once we hold the session state ourselves.
        if (this._status === "connected") {
          this.sendPayload({ type: "snapshot_response", state: this.document.getSnapshot(), seq: this._lastSeq });
        }
        break;

      case "snapshot_response":
        if (this._status !== "joining") break;
        this.suppress(() => this.document.applySnapshot(p.state));
        this._lastSeq = p.seq;
        // Anything we sent before the snapshot landed has been overwritten
        // locally; its echo (buffered) will re-apply it in server order.
        this.pending.clear();
        this.pendingProps.clear();
        this.joinBuffer = this.joinBuffer.filter((m) => (m.seq ?? 0) > p.seq);
        this.finishJoin();
        break;

      case "presence":
        this._presence.set(p.userId, { userId: p.userId, cursor: p.cursor, selection: p.selection });
        this.notifyPresence();
        break;
    }
  }

  private handleChange(msg: Message, change: Change) {
    if (this._status === "joining") {
      this.joinBuffer.push(msg);
      return;
    }
    if (msg.seq !== undefined) this._lastSeq = msg.seq;

    // Echo of one of our own pending changes: already applied locally.
    if (msg.userId === this._userId && msg.cid && this.pending.has(msg.cid)) {
      this.pending.delete(msg.cid);
      this.forEachProp(change, (key) => this.releasePending(key));
      return;
    }

    const masked = this.maskPending(change);
    if (masked) this.suppress(() => this.document.applyChange(masked));
  }

  /**
   * Drop the parts of a remote change that a pending local change also
   * sets. The local value wins until its echo arrives; at that point the
   * server order is authoritative and everyone has converged.
   */
  private maskPending(change: Change): Change | null {
    if (this.pendingProps.size === 0) return change;
    switch (change.type) {
      case "props_changed": {
        const keys = Object.keys(change.props);
        const kept = keys.filter((k) => !this.pendingProps.has(propKey(change.id, k)));
        if (kept.length === keys.length) return change;
        if (kept.length === 0) return null;
        const props: Props = {};
        for (const k of kept) props[k] = change.props[k];
        return { ...change, props };
      }
      case "batch": {
        const kept = change.changes.map((c) => this.maskPending(c)).filter((c): c is Change => c !== null);
        return kept.length ? { ...change, changes: kept } : null;
      }
      default:
        return change;
    }
  }

  private forEachProp(change: Change, fn: (key: string) => void) {
    if (change.type === "props_changed") {
      for (const k of Object.keys(change.props)) fn(propKey(change.id, k));
    } else if (change.type === "batch") {
      for (const c of change.changes) this.forEachProp(c, fn);
    }
  }

  private holdPending(key: string) {
    this.pendingProps.set(key, (this.pendingProps.get(key) ?? 0) + 1);
  }

  private releasePending(key: string) {
    const n = (this.pendingProps.get(key) ?? 0) - 1;
    if (n <= 0) this.pendingProps.delete(key);
    else this.pendingProps.set(key, n);
  }

  // ---- Outgoing ----

  /**
   * Broadcast a change the application has already applied locally.
   * No-op when not in a session, and while `suppressed` (a remote apply
   * must never echo).
   */
  send(change: Change) {
    if (this._suppressed) return;
    if (!this._sessionId || (this._status !== "connected" && this._status !== "joining")) return;
    const cid = this.generateId();
    this.pending.set(cid, change);
    this.forEachProp(change, (key) => this.holdPending(key));
    this.sendPayload(change, cid);
  }

  sendPresence(p: { cursor?: [number, number]; selection?: string[] }) {
    if (this._status !== "connected") return;
    const payload: Presence = { type: "presence", userId: this._userId, ...p };
    this.sendPayload(payload);
  }

  private sendPayload(payload: Payload, cid?: string) {
    if (!this.ws || this.ws.readyState !== this.WS.OPEN || !this._sessionId) return;
    const msg: Message = {
      ts: Date.now(),
      userId: this._userId,
      sessionId: this._sessionId,
      payload,
      ...(cid ? { cid } : {}),
    };
    this.ws.send(JSON.stringify(msg));
  }

  /** Run `fn` with echoing disabled. Re-entrant. */
  suppress<T>(fn: () => T): T {
    const prev = this._suppressed;
    this._suppressed = true;
    try { return fn(); } finally { this._suppressed = prev; }
  }

  // ---- Notifications ----

  private setStatus(s: CollabStatus) {
    this._status = s;
    for (const fn of this.statusListeners) fn(s);
  }
  private notifyUsers() {
    for (const fn of this.usersListeners) fn(new Map(this._users));
  }
  private notifyPresence() {
    const snapshot = this.presence;
    for (const fn of this.presenceListeners) fn(snapshot);
  }
}

function propKey(id: string, prop: string): string {
  return `${id}\u0000${prop}`;
}
