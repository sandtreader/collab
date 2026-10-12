import { describe, it, expect } from "vitest";
import {
  applyChange, applyChanges, emptyState, isTransient, persistentPart, isValidChange, isValidMessage,
  type DocState,
} from "../src/protocol/index.js";

const base = (): DocState => ({
  entities: {
    a: { kind: "rect", props: { x: 1, y: 2, w: 10 } },
    b: { kind: "variable", props: { value: 5 } },
  },
});

describe("applyChange", () => {
  it("adds an entity", () => {
    const s = applyChange(emptyState(), { type: "entity_added", id: "a", kind: "rect", props: { x: 1 } });
    expect(s.entities.a).toEqual({ kind: "rect", props: { x: 1 } });
  });

  it("replaces an entity on duplicate add", () => {
    const s = applyChange(base(), { type: "entity_added", id: "a", kind: "circle", props: { d: 3 } });
    expect(s.entities.a).toEqual({ kind: "circle", props: { d: 3 } });
  });

  it("removes an entity and ignores unknown removal", () => {
    const s1 = applyChange(base(), { type: "entity_removed", id: "a" });
    expect(Object.keys(s1.entities)).toEqual(["b"]);
    const s2 = applyChange(s1, { type: "entity_removed", id: "zzz" });
    expect(s2).toBe(s1);
  });

  it("shallow-merges props and deletes on null", () => {
    const s = applyChange(base(), { type: "props_changed", id: "a", props: { w: 20, y: null, z: "new" } });
    expect(s.entities.a.props).toEqual({ x: 1, w: 20, z: "new" });
  });

  it("ignores props_changed on an unknown id", () => {
    const b = base();
    expect(applyChange(b, { type: "props_changed", id: "nope", props: { x: 1 } })).toBe(b);
  });

  it("applies a batch in order", () => {
    const s = applyChange(base(), {
      type: "batch",
      changes: [
        { type: "entity_added", id: "c", kind: "line", props: { len: 1 } },
        { type: "props_changed", id: "c", props: { len: 2 } },
        { type: "entity_removed", id: "a" },
      ],
    });
    expect(s.entities.c.props.len).toBe(2);
    expect(s.entities.a).toBeUndefined();
  });

  it("replaces state wholesale with a deep copy", () => {
    const incoming: DocState = { entities: { q: { kind: "k", props: { nested: { v: [1, 2] } } } } };
    const s = applyChange(base(), { type: "state_replaced", state: incoming });
    expect(s).toEqual(incoming);
    expect(s.entities.q).not.toBe(incoming.entities.q);
  });

  it("never mutates the input", () => {
    const b = base();
    const frozen = JSON.stringify(b);
    applyChanges(b, [
      { type: "props_changed", id: "a", props: { x: 99 } },
      { type: "entity_removed", id: "b" },
      { type: "entity_added", id: "a", kind: "x", props: {} },
    ]);
    expect(JSON.stringify(b)).toBe(frozen);
  });

  it("converges regardless of order for independent props", () => {
    const c1 = { type: "props_changed" as const, id: "a", props: { x: 100 } };
    const c2 = { type: "props_changed" as const, id: "a", props: { y: 200 } };
    expect(applyChanges(base(), [c1, c2])).toEqual(applyChanges(base(), [c2, c1]));
  });
});

describe("transient", () => {
  it("detects transient props_changed and all-transient batches", () => {
    expect(isTransient({ type: "props_changed", id: "a", props: { p: 1 }, transient: true })).toBe(true);
    expect(isTransient({ type: "props_changed", id: "a", props: { p: 1 } })).toBe(false);
    expect(isTransient({ type: "batch", changes: [
      { type: "props_changed", id: "a", props: { p: 1 }, transient: true },
    ] })).toBe(true);
  });

  it("strips transient parts from a batch", () => {
    const kept = persistentPart({ type: "batch", changes: [
      { type: "props_changed", id: "a", props: { p: 1 }, transient: true },
      { type: "entity_removed", id: "b" },
    ] });
    expect(kept).toEqual({ type: "batch", changes: [{ type: "entity_removed", id: "b" }] });
    expect(persistentPart({ type: "props_changed", id: "a", props: {}, transient: true })).toBeNull();
  });
});

describe("validation", () => {
  it("accepts well-formed changes and rejects junk", () => {
    expect(isValidChange({ type: "entity_added", id: "a", kind: "k", props: {} })).toBe(true);
    expect(isValidChange({ type: "entity_added", id: "a", props: {} })).toBe(false);
    expect(isValidChange({ type: "props_changed", id: "a", props: [] })).toBe(false);
    expect(isValidChange({ type: "batch", changes: [{ type: "entity_removed", id: "x" }] })).toBe(true);
    expect(isValidChange({ type: "batch", changes: [{ type: "nope" }] })).toBe(false);
    expect(isValidChange({ type: "state_replaced", state: { entities: {} } })).toBe(true);
    expect(isValidChange(null)).toBe(false);
  });

  it("checks message envelopes", () => {
    expect(isValidMessage({ ts: 1, userId: "u", sessionId: "s", payload: { type: "join" } })).toBe(true);
    expect(isValidMessage({ ts: 1, userId: "u", payload: { type: "join" } })).toBe(false);
    expect(isValidMessage("nope")).toBe(false);
  });
});
