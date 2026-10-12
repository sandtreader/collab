import { applyChange, emptyState, type Change, type DocState } from "../src/protocol/index.js";
import type { CollabDocument } from "../src/client/index.js";

/** A plain-state document adapter that records what it was asked to apply. */
export class MemoryDocument implements CollabDocument {
  state: DocState = emptyState();
  applied: Change[] = [];
  snapshots = 0;

  getSnapshot() { return JSON.parse(JSON.stringify(this.state)); }
  applySnapshot(s: DocState) { this.state = JSON.parse(JSON.stringify(s)); this.snapshots++; }
  applyChange(c: Change) { this.applied.push(c); this.state = applyChange(this.state, c); }

  /** Local edit: apply then let the caller send. */
  local(c: Change) { this.state = applyChange(this.state, c); return c; }
}

export async function waitFor(cond: () => boolean, ms = 2000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
