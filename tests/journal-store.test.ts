import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FabricJournalStore } from "../src/journal/store.js";

const roots: string[] = [];

const mkRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-journal-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("FabricJournalStore", () => {
  it("keys on call content, not position, and is stable across identical inputs", () => {
    const store = new FabricJournalStore(mkRoot(), "run-1");
    const other = new FabricJournalStore(mkRoot(), "run-1");
    const input = {
      prompt: "summarize the diff",
      model: "acme/nimbus-3",
      runner: "pi",
      schema: { type: "object" },
      tools: ["read", "grep"],
    };

    expect(store.contentHash(input)).toBe(other.contentHash(input));
    // A different prompt changes the hash (miss on prompt change).
    expect(store.contentHash({ ...input, prompt: "explain the diff" })).not.toBe(
      store.contentHash(input),
    );
    // A different model changes the hash.
    expect(store.contentHash({ ...input, model: "acme/nimbus-9" })).not.toBe(
      store.contentHash(input),
    );
    // A different tool set changes the hash.
    expect(store.contentHash({ ...input, tools: ["read"] })).not.toBe(
      store.contentHash(input),
    );
    // An inherited-vs-empty model default is normalized by the caller, not here;
    // the store treats "" as its own content.
    expect(store.contentHash({ ...input, model: "" })).not.toBe(store.contentHash(input));
  });

  it("advances a per-content occurrence counter so identical calls map to distinct entries", () => {
    const store = new FabricJournalStore(mkRoot(), "run-1");
    const input = { prompt: "same call", model: "acme/nimbus-3", runner: "pi" };
    const other = { prompt: "different call", model: "acme/nimbus-3", runner: "pi" };

    const first = store.reserve(input);
    const second = store.reserve(input);
    const interleavedOther = store.reserve(other);
    const third = store.reserve(input);

    expect(first.occurrence).toBe(0);
    expect(second.occurrence).toBe(1);
    expect(third.occurrence).toBe(2);
    expect(first.entryKey).not.toBe(second.entryKey);
    expect(first.contentHash).toBe(second.contentHash);
    // An unrelated call in between does not perturb the content occurrence.
    expect(interleavedOther.occurrence).toBe(0);
    expect(interleavedOther.contentHash).not.toBe(first.contentHash);
  });

  it("re-runs replay the same entry keys in program order (fresh counter per store)", () => {
    const root = mkRoot();
    const input = { prompt: "same call", model: "acme/nimbus-3", runner: "pi" };

    const firstRun = new FabricJournalStore(root, "run-1");
    const a0 = firstRun.reserve(input);
    const a1 = firstRun.reserve(input);
    firstRun.write(a0.entryKey, { value: "first" });
    firstRun.write(a1.entryKey, { value: "second" });

    const replayRun = new FabricJournalStore(root, "run-1");
    const b0 = replayRun.reserve(input);
    const b1 = replayRun.reserve(input);
    expect(b0.entryKey).toBe(a0.entryKey);
    expect(b1.entryKey).toBe(a1.entryKey);
    expect(replayRun.read(b0.entryKey)).toEqual({ value: "first" });
    expect(replayRun.read(b1.entryKey)).toEqual({ value: "second" });
  });

  it("misses on an unwritten entry and hits after a write, scoped by journalKey", () => {
    const root = mkRoot();
    const input = { prompt: "call", model: "acme/nimbus-3", runner: "pi" };

    const store = new FabricJournalStore(root, "key-a");
    const reservation = store.reserve(input);
    expect(store.read(reservation.entryKey)).toBeUndefined();
    store.write(reservation.entryKey, { status: "completed", value: 42 });
    expect(store.read(reservation.entryKey)).toEqual({ status: "completed", value: 42 });

    // A different journalKey is an isolated namespace: same content, no hit.
    const otherKey = new FabricJournalStore(root, "key-b");
    const otherReservation = otherKey.reserve(input);
    expect(otherReservation.entryKey).toBe(reservation.entryKey);
    expect(otherKey.read(otherReservation.entryKey)).toBeUndefined();
  });

  it("persists entries under .pi/fabric/journal/<journalKey>/", () => {
    const root = mkRoot();
    const store = new FabricJournalStore(root, "my/key with spaces");
    const reservation = store.reserve({ prompt: "x", model: "m", runner: "pi" });
    store.write(reservation.entryKey, { ok: true });
    const dir = path.join(root, ".pi", "fabric", "journal");
    const [journalDir] = fs.readdirSync(dir);
    // The journalKey is sanitized to a filesystem-safe directory name.
    expect(journalDir).toBe("my_key_with_spaces");
    expect(fs.existsSync(path.join(dir, journalDir!, `${reservation.entryKey}.json`))).toBe(true);
  });
});
