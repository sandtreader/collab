import { useEffect, useState } from "react";
import type { CollabClient, CollabStatus, RemotePresence } from "../client/index.js";

export interface CollabSnapshot {
  status: CollabStatus;
  sessionId: string | null;
  users: Map<string, string>;
  presence: RemotePresence[];
}

/** Subscribe a component to a client's status, members and presence. */
export function useCollab(client: CollabClient): CollabSnapshot {
  const [status, setStatus] = useState(client.status);
  const [sessionId, setSessionId] = useState(client.sessionId);
  const [users, setUsers] = useState(() => new Map(client.users));
  const [presence, setPresence] = useState(() => client.presence);

  useEffect(() => {
    setStatus(client.status);
    setSessionId(client.sessionId);
    setUsers(new Map(client.users));
    setPresence(client.presence);
    const u1 = client.onStatus((s) => { setStatus(s); setSessionId(client.sessionId); });
    const u2 = client.onUsers((u) => setUsers(new Map(u)));
    const u3 = client.onPresence(setPresence);
    return () => { u1(); u2(); u3(); };
  }, [client]);

  return { status, sessionId, users, presence };
}
