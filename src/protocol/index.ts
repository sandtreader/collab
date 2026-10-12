// @sandtreader/collab — protocol
//
// Model-agnostic wire types and the pure apply rules for an entity document.
// No dependencies; shared by the client, the server and consumers' tests.

// ---- Entity document ----

export type PropValue =
  | number
  | string
  | boolean
  | null
  | PropValue[]
  | { [key: string]: PropValue };

export type Props = Record<string, PropValue>;

export interface Entity {
  kind: string;
  props: Props;
}

export interface DocState {
  entities: Record<string, Entity>;
}

export function emptyState(): DocState {
  return { entities: {} };
}

// ---- Document changes ----

export interface EntityAdded {
  type: "entity_added";
  id: string;
  kind: string;
  props: Props;
}

export interface EntityRemoved {
  type: "entity_removed";
  id: string;
}

export interface PropsChanged {
  type: "props_changed";
  id: string;
  /** Shallow merge. A key set to `null` is removed. */
  props: Props;
  /** First message of a drag or slide — undo group boundary. */
  gestureStart?: boolean;
  /** Last message of a drag or slide. */
  gestureEnd?: boolean;
  /** Apply but don't persist (e.g. one-shot input pokes). */
  transient?: boolean;
}

export interface Batch {
  type: "batch";
  changes: Change[];
}

export interface StateReplaced {
  type: "state_replaced";
  state: DocState;
}

export type Change = EntityAdded | EntityRemoved | PropsChanged | Batch | StateReplaced;

export const CHANGE_TYPES: ReadonlySet<string> = new Set([
  "entity_added", "entity_removed", "props_changed", "batch", "state_replaced",
]);

export function isChange(p: Payload): p is Change {
  return CHANGE_TYPES.has(p.type);
}

// ---- Session ----

export type SessionMessage =
  | { type: "join"; userId: string; displayName: string }
  | { type: "leave"; userId: string }
  /** Server → joiner only. Current members (excluding the joiner) and sequence. */
  | { type: "session_info"; members: Record<string, string>; seq: number }
  | { type: "snapshot_request" }
  /** `seq` is the last change the provider had applied when it took the snapshot. */
  | { type: "snapshot_response"; state: DocState; seq: number };

// ---- Presence ----

export interface Presence {
  type: "presence";
  userId: string;
  /** Model coordinates; the receiver maps through its own viewport. */
  cursor?: [number, number];
  /** Entity IDs this user has selected. */
  selection?: string[];
}

// ---- Envelope ----

export type Payload = Change | SessionMessage | Presence;

export interface Message {
  /** Server-assigned, monotonic per session. Present on every relayed change. */
  seq?: number;
  /** Client-generated change ID, used to recognise the echo of one's own change. */
  cid?: string;
  ts: number;
  userId: string;
  sessionId: string;
  payload: Payload;
}

// ---- Pure apply rules ----
//
// These define convergence. Every implementation (client-side stores, the
// authoritative server, tests) must agree with them:
//   - entity_added on an existing ID replaces the entity
//   - props_changed on an unknown ID is ignored
//   - entity_removed on an unknown ID is ignored
//   - props_changed is a shallow merge; a null value deletes the key
//   - batch applies in order
//   - state_replaced discards everything and loads the given state
//
// The functions are immutable: they return a new state and never mutate
// the input. Unchanged entities are shared by reference.

export function applyChange(state: DocState, change: Change): DocState {
  switch (change.type) {
    case "entity_added":
      return {
        entities: { ...state.entities, [change.id]: { kind: change.kind, props: { ...change.props } } },
      };

    case "entity_removed": {
      if (!(change.id in state.entities)) return state;
      const { [change.id]: _removed, ...rest } = state.entities;
      return { entities: rest };
    }

    case "props_changed": {
      const existing = state.entities[change.id];
      if (!existing) return state;
      return {
        entities: {
          ...state.entities,
          [change.id]: { kind: existing.kind, props: mergeProps(existing.props, change.props) },
        },
      };
    }

    case "batch":
      return change.changes.reduce(applyChange, state);

    case "state_replaced":
      return cloneState(change.state);
  }
}

export function applyChanges(state: DocState, changes: Iterable<Change>): DocState {
  let s = state;
  for (const c of changes) s = applyChange(s, c);
  return s;
}

export function mergeProps(base: Props, patch: Props): Props {
  const out: Props = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

export function cloneState(state: DocState): DocState {
  return JSON.parse(JSON.stringify({ entities: state.entities ?? {} }));
}

/** True if the change carries nothing worth persisting (transient or empty). */
export function isTransient(change: Change): boolean {
  switch (change.type) {
    case "props_changed": return change.transient === true;
    case "batch": return change.changes.every(isTransient);
    default: return false;
  }
}

/** Strip transient parts from a change; returns null if nothing remains. */
export function persistentPart(change: Change): Change | null {
  if (change.type === "batch") {
    const kept = change.changes.map(persistentPart).filter((c): c is Change => c !== null);
    if (kept.length === 0) return null;
    return { type: "batch", changes: kept };
  }
  return isTransient(change) ? null : change;
}

// ---- Validation ----
//
// The relay is app-blind and trusts nothing. These checks are shape-only.

export function isValidMessage(x: unknown): x is Message {
  if (!isObject(x)) return false;
  const m = x as Record<string, unknown>;
  return typeof m.ts === "number"
    && typeof m.userId === "string"
    && typeof m.sessionId === "string"
    && isObject(m.payload)
    && typeof (m.payload as Record<string, unknown>).type === "string";
}

export function isValidChange(x: unknown): x is Change {
  if (!isObject(x)) return false;
  const c = x as Record<string, unknown>;
  switch (c.type) {
    case "entity_added":
      return typeof c.id === "string" && typeof c.kind === "string" && isObject(c.props);
    case "entity_removed":
      return typeof c.id === "string";
    case "props_changed":
      return typeof c.id === "string" && isObject(c.props);
    case "batch":
      return Array.isArray(c.changes) && c.changes.every(isValidChange);
    case "state_replaced":
      return isObject(c.state) && isObject((c.state as Record<string, unknown>).entities);
    default:
      return false;
  }
}

function isObject(x: unknown): x is object {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
