import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeBudgetState,
  appendBudgetLedger,
  clearOwnedBudgetEnv,
  initBudgetLedger,
  readBudgetLedger,
} from "../src/agents/budget-ledger.js";

const temporaryFiles: string[] = [];

afterEach(() => {
  clearOwnedBudgetEnv();
  for (const file of temporaryFiles.splice(0)) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

describe("budget ledger", () => {
  it("reports no active budget by default", () => {
    expect(activeBudgetState()).toBeUndefined();
  });

  it("initializes a ledger and round-trips through the environment", () => {
    const state = initBudgetLedger(0.25);
    temporaryFiles.push(state.file);
    expect(state.budget).toBe(0.25);
    expect(fs.existsSync(state.file)).toBe(true);
    const inherited = activeBudgetState();
    expect(inherited).toBeDefined();
    expect(inherited?.budget).toBe(0.25);
    expect(inherited?.file).toBe(state.file);
    expect(inherited?.id).toBe(state.id);
  });

  it("treats a non-positive budget as inactive", () => {
    process.env.PI_FABRIC_BUDGET = "0";
    process.env.PI_FABRIC_BUDGET_FILE = "/tmp/ignored";
    process.env.PI_FABRIC_BUDGET_ID = "x";
    try {
      expect(activeBudgetState()).toBeUndefined();
    } finally {
      clearOwnedBudgetEnv();
    }
  });

  it("sums appended entries and tolerates malformed lines", () => {
    const state = initBudgetLedger(1);
    temporaryFiles.push(state.file);
    appendBudgetLedger(state.file, {
      id: "a",
      depth: 1,
      cost: 0.06,
      tokens: 30,
      ts: 1,
    });
    appendBudgetLedger(state.file, {
      id: "b",
      depth: 2,
      cost: 0.04,
      tokens: 70,
      ts: 2,
    });
    fs.appendFileSync(state.file, "not json\n\n");
    const summary = readBudgetLedger(state.file);
    expect(summary.cost).toBeCloseTo(0.1);
    expect(summary.tokens).toBe(100);
  });

  it("returns zero for a missing ledger file", () => {
    expect(readBudgetLedger(path.join(os.tmpdir(), "pi-fabric-missing-cost.jsonl"))).toEqual({
      cost: 0,
      tokens: 0,
    });
  });

  it("counts an outstanding reservation until a settlement supersedes it", () => {
    const state = initBudgetLedger(1);
    temporaryFiles.push(state.file);
    appendBudgetLedger(state.file, {
      id: "child-1",
      depth: 1,
      cost: 0.05,
      tokens: 0,
      ts: 1,
      kind: "reservation",
    });
    // Reservation is counted against the budget before the child settles.
    expect(readBudgetLedger(state.file).cost).toBeCloseTo(0.05);
    expect(readBudgetLedger(state.file).tokens).toBe(0);

    appendBudgetLedger(state.file, {
      id: "child-1",
      depth: 1,
      cost: 0.02,
      tokens: 40,
      ts: 2,
      kind: "settlement",
    });
    // The settlement replaces the estimate with the actual cost, by id.
    const summary = readBudgetLedger(state.file);
    expect(summary.cost).toBeCloseTo(0.02);
    expect(summary.tokens).toBe(40);
  });

  it("sums outstanding reservations alongside legacy settled entries", () => {
    const state = initBudgetLedger(1);
    temporaryFiles.push(state.file);
    // A legacy entry (no kind) written by an older version is a settled cost.
    appendBudgetLedger(state.file, { id: "legacy", depth: 1, cost: 0.03, tokens: 10, ts: 1 });
    appendBudgetLedger(state.file, {
      id: "a",
      depth: 1,
      cost: 0.04,
      tokens: 0,
      ts: 2,
      kind: "reservation",
    });
    appendBudgetLedger(state.file, {
      id: "b",
      depth: 1,
      cost: 0.05,
      tokens: 0,
      ts: 3,
      kind: "reservation",
    });
    const summary = readBudgetLedger(state.file);
    // legacy settled 0.03 + reservation a 0.04 + reservation b 0.05.
    expect(summary.cost).toBeCloseTo(0.12);
    expect(summary.tokens).toBe(10);
  });

  it("closes the concurrent-spawn overshoot race with reserve-then-settle", () => {
    const state = initBudgetLedger(0.1);
    temporaryFiles.push(state.file);
    const reserve = 0.06;
    // Simulate managers admitting concurrently: each appends its reservation and
    // re-reads the ledger before any child has settled. Over-budget spawns roll
    // their reservation back with a zero-cost settlement, exactly as the manager
    // does. With the old append-after-completion model both spawns would have
    // seen $0 spent and passed, overshooting to $0.12.
    const admit = (id: string): boolean => {
      appendBudgetLedger(state.file, {
        id,
        depth: 1,
        cost: reserve,
        tokens: 0,
        ts: 1,
        kind: "reservation",
      });
      if (readBudgetLedger(state.file).cost > state.budget) {
        appendBudgetLedger(state.file, {
          id,
          depth: 1,
          cost: 0,
          tokens: 0,
          ts: 1,
          kind: "settlement",
        });
        return false;
      }
      return true;
    };
    expect(admit("a")).toBe(true); // reserved 0.06
    expect(admit("b")).toBe(false); // 0.12 > 0.10 -> rejected before running
    // Only the admitted reservation remains outstanding; no overshoot.
    expect(readBudgetLedger(state.file).cost).toBeCloseTo(0.06);

    // The admitted child settles below its estimate; a later spawn now fits.
    appendBudgetLedger(state.file, {
      id: "a",
      depth: 1,
      cost: 0.05,
      tokens: 20,
      ts: 2,
      kind: "settlement",
    });
    expect(readBudgetLedger(state.file).cost).toBeCloseTo(0.05);
    // 0.05 settled + 0.06 reserve = 0.11 > 0.10, so c is rejected and rolled back.
    expect(admit("c")).toBe(false);
    expect(readBudgetLedger(state.file).cost).toBeCloseTo(0.05);
  });
});
