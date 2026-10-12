// Session IDs (`abc-defg-hij`), URL helpers and auto-join.

import { Filter } from "bad-words";
import type { CollabClient } from "../client/index.js";

export interface SessionConfig {
  /** Relay base URL, e.g. `wss://relay.example.com`. The client appends `/<app>`. */
  serverUrl: string;
  /** Prefix for shareable links, e.g. `https://synflo.net/s/`. */
  sessionUrlPrefix: string;
  /** localStorage key prefix for identity. Default `collab`. */
  storageKeyPrefix?: string;
  /** Show the QR code button. Default true. */
  showQr?: boolean;
  /** URL path prefix that auto-joins, e.g. `/s/`. Default `/s/`. */
  joinPathPrefix?: string;
}

export const SESSION_ID_REGEX = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

const profanity = new Filter();

function profane(id: string): boolean {
  return profanity.isProfane(id.replace(/-/g, " "));
}

export function generateSessionId(): string {
  const seg = (n: number) =>
    Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
  let id: string;
  do {
    id = `${seg(3)}-${seg(4)}-${seg(3)}`;
  } while (profane(id));
  return id;
}

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_REGEX.test(id) && !profane(id);
}

/** Accepts a bare ID or a full share URL; returns the normalised ID or null. */
export function parseSessionInput(input: string): string | null {
  const code = input.trim().toLowerCase().replace(/^.*\//, "");
  return isValidSessionId(code) ? code : null;
}

export function sessionUrl(config: SessionConfig, sessionId: string): string {
  return `${config.sessionUrlPrefix}${sessionId}`;
}

/** Extract a session ID from a path like `/s/abc-defg-hij`. */
export function sessionFromPath(pathname: string, joinPathPrefix = "/s/"): string | null {
  if (!pathname.startsWith(joinPathPrefix)) return null;
  const rest = pathname.slice(joinPathPrefix.length).replace(/\/$/, "");
  return isValidSessionId(rest) ? rest : null;
}

/** Join the session named in the current URL, if any. Returns true if joining. */
export function autoJoinFromUrl(client: CollabClient, config: SessionConfig): boolean {
  if (!config.serverUrl) return false;
  if (client.status !== "disconnected") return false;
  const id = sessionFromPath(window.location.pathname, config.joinPathPrefix);
  if (!id) return false;
  client.connect(id, config.serverUrl);
  return true;
}
