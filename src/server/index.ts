// @sandtreader/collab — relay server
//
// Sequenced, app-blind WebSocket relay. Holds only connection state: it
// never interprets entities. Per session it
//   - stamps every document change with a monotonic `seq` and echoes it to
//     every member, including the sender (one total order per session)
//   - answers a `join` with `session_info` (current members + seq) to the
//     joiner alone
//   - forwards `snapshot_request` to one other member and routes the
//     `snapshot_response` back only to the requester(s)
//   - broadcasts presence / join / leave to everyone except the sender
//
// Sessions are namespaced by app: `ws://host?app=<app>` (or a trailing
// path segment) keys sessions as `<app>:<sessionId>`, so two apps can share
// one relay without being able to join each other's sessions.

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { isValidChange, isValidMessage, emptyState, type Message } from "../protocol/index.js";

export interface RelayOptions {
  /** Listen on this port. Ignored when `server` is given. */
  port?: number;
  host?: string;
  /** Attach to an existing HTTP server instead of listening. */
  server?: HttpServer;
  /** App name used when the connection URL has no path segment. */
  defaultApp?: string;
  log?: (line: string) => void;
}

export interface Relay {
  /** Number of live sessions across all apps. */
  sessionCount(): number;
  /** Members of a session, or undefined if it doesn't exist. */
  members(app: string, sessionId: string): Record<string, string> | undefined;
  /** Bound port, once listening. */
  port(): number | undefined;
  close(): Promise<void>;
}

interface Client {
  ws: WebSocket;
  userId: string;
  displayName: string;
  session: Session;
}

interface Session {
  key: string;
  app: string;
  id: string;
  clients: Set<Client>;
  seq: number;
  /** Members awaiting a snapshot_response. */
  pendingSnapshot: Set<Client>;
}

export function createRelay(opts: RelayOptions = {}): Relay {
  const log = opts.log ?? (() => {});
  const defaultApp = opts.defaultApp ?? "default";
  const wss = opts.server
    ? new WebSocketServer({ server: opts.server })
    : new WebSocketServer({ port: opts.port ?? 0, host: opts.host });

  const sessions = new Map<string, Session>();

  function getSession(app: string, id: string): Session {
    const key = `${app}:${id}`;
    let s = sessions.get(key);
    if (!s) {
      s = { key, app, id, clients: new Set(), seq: 0, pendingSnapshot: new Set() };
      sessions.set(key, s);
    }
    return s;
  }

  function sendTo(client: Client, msg: Message | string) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  function broadcast(session: Session, msg: Message | string, exclude?: Client) {
    const raw = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const c of session.clients) {
      if (c !== exclude) sendTo(c, raw);
    }
  }

  function memberList(session: Session, exclude?: Client): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of session.clients) {
      if (c !== exclude) out[c.userId] = c.displayName;
    }
    return out;
  }

  function removeClient(client: Client) {
    const session = client.session;
    session.clients.delete(client);
    session.pendingSnapshot.delete(client);
    if (session.clients.size === 0) sessions.delete(session.key);
  }

  function serverMessage(session: Session, payload: Message["payload"]): Message {
    return { ts: Date.now(), userId: "", sessionId: session.id, payload };
  }

  wss.on("connection", (ws, req: IncomingMessage) => {
    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()
      ?? req.socket.remoteAddress ?? "unknown";
    const app = appFromUrl(req.url, defaultApp);
    let client: Client | null = null;

    ws.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!isValidMessage(msg)) return;
      const p = msg.payload;

      // ---- First message must be a join; it establishes the session ----
      if (!client) {
        if (p.type !== "join") {
          ws.close(4000, "expected join");
          return;
        }
        const session = getSession(app, msg.sessionId);
        client = { ws, userId: p.userId, displayName: p.displayName, session };
        const members = memberList(session);
        session.clients.add(client);
        sendTo(client, serverMessage(session, { type: "session_info", members, seq: session.seq }));
        broadcast(session, msg, client);
        log(`join ${p.userId} ${session.key} ip=${ip} (${session.clients.size} connected)`);
        return;
      }

      const session = client.session;

      switch (p.type) {
        case "join":
          // Display name update
          client.displayName = p.displayName;
          broadcast(session, msg, client);
          break;

        case "snapshot_request": {
          const provider = [...session.clients].find((c) => c !== client && c.ws.readyState === WebSocket.OPEN);
          if (!provider) {
            // Nobody else here: the requester is effectively first.
            sendTo(client, serverMessage(session, { type: "snapshot_response", state: emptyState(), seq: session.seq }));
            break;
          }
          session.pendingSnapshot.add(client);
          sendTo(provider, msg);
          break;
        }

        case "snapshot_response": {
          const raw = JSON.stringify(msg);
          for (const requester of session.pendingSnapshot) {
            if (requester !== client) sendTo(requester, raw);
          }
          session.pendingSnapshot.clear();
          break;
        }

        case "entity_added":
        case "entity_removed":
        case "props_changed":
        case "batch":
        case "state_replaced": {
          if (!isValidChange(p)) return;
          const stamped: Message = { ...msg, seq: ++session.seq };
          broadcast(session, stamped);
          break;
        }

        case "presence":
        case "leave":
          broadcast(session, msg, client);
          break;

        default:
          // Unknown or server-only types from a client are dropped.
          break;
      }
    });

    ws.on("close", () => {
      if (!client) return;
      const session = client.session;
      removeClient(client);
      log(`leave ${client.userId} ${session.key} ip=${ip} (${session.clients.size} remaining)`);
      if (session.clients.size > 0) {
        broadcast(session, serverMessage(session, { type: "leave", userId: client.userId }));
      }
    });

    ws.on("error", () => {
      if (client) removeClient(client);
    });
  });

  return {
    sessionCount: () => sessions.size,
    members: (app, id) => {
      const s = sessions.get(`${app}:${id}`);
      return s ? memberList(s) : undefined;
    },
    port: () => {
      const a = wss.address();
      return typeof a === "object" && a ? a.port : undefined;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

/**
 * App namespace from the connection URL. Prefers the `app` query parameter
 * (what the client sends; survives reverse-proxy path rewriting), then the
 * last path segment, then the fallback.
 */
export function appFromUrl(url: string | undefined, fallback: string): string {
  if (!url) return fallback;
  const [path, query = ""] = url.split("?", 2);
  const fromQuery = new URLSearchParams(query).get("app");
  if (fromQuery) return fromQuery;
  const segs = path.split("/").filter(Boolean);
  const last = segs[segs.length - 1];
  return last ? decodeURIComponent(last) : fallback;
}
