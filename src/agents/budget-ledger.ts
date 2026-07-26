import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cross-process cost budget ledger for a Fabric recursion tree.
 *
 * A recursion tree spans one Pi process per node. Each node's AgentManager
 * records the cost of the children it spawns into a single append-only JSONL
 * file, and checks the accumulated spend before spawning another child. The
 * ledger path and budget travel to descendants through PI_FABRIC_BUDGET*
 * environment variables, which the worker forwards to child Pi processes via
 * `{ ...process.env }`.
 *
 * This mirrors ypi's RLM_BUDGET / RLM_COST_FILE model, but closes the overshoot
 * race with reserve-then-settle accounting. At spawn time the manager appends a
 * `reservation` entry (an estimate) and only then re-reads the ledger; on
 * completion it appends a `settlement` entry with the same `id`, which
 * supersedes the reservation and records the actual cost. Because the pre-spawn
 * check counts settled cost plus every outstanding reservation, concurrent
 * spawns can no longer all pass the check before any cost lands.
 *
 * Ledger format (append-only JSONL, backward compatible):
 *   - `kind: "reservation"` — an at-spawn estimate, superseded once its `id`
 *     settles. Counted only while no settlement for the same `id` exists.
 *   - `kind: "settlement"`  — the actual cost of a finished (or cancelled, at
 *     cost 0) child. Supersedes any reservation with the same `id`.
 *   - no `kind`             — a settled cost written by an older version; still
 *     treated as a settlement so old ledgers read correctly.
 *
 * The race-free ceiling remains the per-execution call count
 * (agents.maxPerExecution). Reservations bound the concurrency race; they do not
 * make the estimate exact, so a tree can still overshoot by the estimation error.
 */

export type BudgetLedgerEntryKind = "reservation" | "settlement";

export interface BudgetLedgerEntry {
  id: string;
  depth: number;
  cost: number;
  tokens: number;
  ts: number;
  /** Absent entries are treated as settled costs written by older versions. */
  kind?: BudgetLedgerEntryKind;
}

export interface BudgetLedgerSummary {
  cost: number;
  tokens: number;
}

export interface BudgetLedgerState {
  budget: number;
  file: string;
  id: string;
}

const ENV_BUDGET = "PI_FABRIC_BUDGET";
const ENV_BUDGET_FILE = "PI_FABRIC_BUDGET_FILE";
const ENV_BUDGET_ID = "PI_FABRIC_BUDGET_ID";

const parseFloatFinite = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Read the active budget state inherited from the recursion-tree root.
 * Returns undefined when no budget is active for this process.
 */
export function activeBudgetState(): BudgetLedgerState | undefined {
  const file = process.env[ENV_BUDGET_FILE];
  const budget = parseFloatFinite(process.env[ENV_BUDGET]);
  if (!file || budget === undefined || budget <= 0) return undefined;
  return { budget, file, id: process.env[ENV_BUDGET_ID] ?? "" };
}

/**
 * Initialize a shared ledger for a recursion tree and seed the environment
 * variables that descendants inherit. Only call at the tree root (depth 0)
 * when no budget has been inherited and a positive budget is configured.
 */
export function initBudgetLedger(budget: number): BudgetLedgerState {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-budget-"));
  const file = path.join(directory, "cost.jsonl");
  fs.writeFileSync(file, "", { mode: 0o600 });
  const id = randomUUID().replaceAll("-", "").slice(0, 16);
  process.env[ENV_BUDGET] = String(budget);
  process.env[ENV_BUDGET_FILE] = file;
  process.env[ENV_BUDGET_ID] = id;
  return { budget, file, id };
}

/**
 * Clear the budget environment variables seeded by initBudgetLedger. Called by
 * the owning (depth-0) manager on close so a long-lived host process does not
 * leak an active budget into a later, unrelated session.
 */
export function clearOwnedBudgetEnv(): void {
  delete process.env[ENV_BUDGET];
  delete process.env[ENV_BUDGET_FILE];
  delete process.env[ENV_BUDGET_ID];
}

/**
 * Sum the append-only ledger under reserve-then-settle semantics: settled cost
 * plus every reservation that has not yet been superseded by a settlement with
 * the same `id`. Entries with no `kind` are treated as settlements so ledgers
 * written by older versions read identically. Malformed lines are tolerated,
 * matching ypi's rlm_cost parser: a single bad entry must not abort the read.
 */
export function readBudgetLedger(file: string): BudgetLedgerSummary {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { cost: 0, tokens: 0 };
  }
  const settled = new Map<string, { cost: number; tokens: number }>();
  const reservations = new Map<string, { cost: number; tokens: number }>();
  // Entries without an id cannot be correlated across reserve/settle; count
  // them verbatim so a hand-written or legacy line is never silently dropped.
  let anonymousCost = 0;
  let anonymousTokens = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<BudgetLedgerEntry>;
      const cost = Number(parsed.cost) || 0;
      const tokens = Number(parsed.tokens) || 0;
      const id = typeof parsed.id === "string" ? parsed.id : undefined;
      if (id === undefined) {
        anonymousCost += cost;
        anonymousTokens += tokens;
      } else if (parsed.kind === "reservation") {
        reservations.set(id, { cost, tokens });
      } else {
        // "settlement" or a legacy entry with no kind field.
        settled.set(id, { cost, tokens });
      }
    } catch {
      // Ignore malformed cost lines; the ledger is best-effort.
    }
  }
  let cost = anonymousCost;
  let tokens = anonymousTokens;
  for (const entry of settled.values()) {
    cost += entry.cost;
    tokens += entry.tokens;
  }
  for (const [id, entry] of reservations) {
    if (settled.has(id)) continue; // superseded by an actual settlement
    cost += entry.cost;
    tokens += entry.tokens;
  }
  return { cost, tokens };
}

/**
 * Append an entry to the shared ledger. O_APPEND makes small single-line writes
 * atomic across concurrent writers on POSIX, which is sufficient because each
 * manager appends one reservation at spawn time and one settlement afterwards.
 */
export function appendBudgetLedger(file: string, entry: BudgetLedgerEntry): void {
  try {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // A ledger write failure must not break the agent run; the next check
    // still guards against runaway spend via the per-execution call ceiling.
  }
}
