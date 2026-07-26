---
name: fabric-resume
description: Durable checkpointed fan-out — journals each completed item to the project mesh (keyed by item identity + prompt hash) so a crashed, interrupted, or re-invoked run skips finished work and pays only for what changed. Use for long fan-outs over many items where a restart must not re-run everything.
disable-model-invocation: true
---

# Fabric Resume

A 50-item fan-out that dies at item 37 should not cost 50 items to finish. This skill journals per-item outcomes to the durable mesh state store as they complete; re-running the same program with the same `strings.runKey` replays journaled results instantly and executes only the missing or changed items. Two design rules make the journal sound: entries are keyed by **item identity plus a hash of the prompt that produced them** — not by call position — so adding, removing, or reordering items never invalidates unrelated entries, and editing the prompt template invalidates exactly the items it affects; and entries are written with **compare-and-swap** (`ifVersion: 0` on first write) so a concurrent duplicate run cannot double-write.

Pass `strings.task` (the objective), `strings.runKey` (a stable, human-chosen name for this run — reusing it is what resumes; a new key is a fresh run), and optionally `strings.fresh` (any non-empty value discards the journal first).

```ts
type ItemOutcome = { item: string; status: "completed" | "failed"; finding: string; promptHash: number };

// Small stable string hash (djb2) — content-keys the journal so edited
// prompts re-run exactly the affected items, nothing else.
const hash = (s: string): number => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
};
const ns = `resume/${π.runKey}`;

await workflow.configure({
  name: `Resumable run: ${π.runKey}`,
  description: "journaled fan-out — completed items replay from mesh",
});

if (π.fresh) {
  const stale = await mesh.list<ItemOutcome>({ prefix: `${ns}/` });
  for (const entry of stale) await mesh.delete({ key: entry.key });
  log(`cleared ${stale.length} journaled entries for ${π.runKey}`);
}

await phase("Discover", { total: 1 });
const inventory = await agent<{ items: string[] }>(
  `Discover the bounded work items for this objective. Be deterministic: derive items from the repository state, not from invention, so a re-run finds the same list.\n\nObjective:\n${π.task}`,
  {
    label: "inventory",
    tools: ["read", "grep", "find", "ls"],
    thinking: "low",
    schema: {
      type: "object",
      properties: { items: { type: "array", maxItems: 64, items: { type: "string" } } },
      required: ["items"],
      additionalProperties: false,
    },
  },
);
const items = [...new Set(inventory.items.map((i) => i.trim()).filter(Boolean))];

const promptFor = (item: string) =>
  `Analyze this bounded item with verbatim evidence from tool output: ${item}\n\nObjective:\n${π.task}`;

await phase("Work", { total: items.length });
let replayed = 0;
const outcomes = await parallel(
  items.map((item) => async (): Promise<ItemOutcome> => {
    const key = `${ns}/${hash(item)}`;
    const expected = hash(promptFor(item));
    const cached = await mesh.get<ItemOutcome>({ key });
    // Replay only a completed entry whose prompt hash still matches; failed
    // entries and stale-prompt entries run live.
    if (cached && cached.value.status === "completed" && cached.value.promptHash === expected) {
      replayed++;
      return cached.value;
    }
    let outcome: ItemOutcome;
    try {
      const finding = await agent(promptFor(item), {
        label: `work ${item}`.slice(0, 50),
        tools: ["read", "grep", "find", "ls"],
      });
      outcome = { item, status: "completed", finding, promptHash: expected };
    } catch (error) {
      outcome = {
        item,
        status: "failed",
        finding: error instanceof Error ? error.message : String(error),
        promptHash: expected,
      };
    }
    // CAS: first write wins (ifVersion 0 on create); a stale entry is replaced
    // at its observed version so a concurrent duplicate run can't double-write.
    try {
      await mesh.put({ key, value: outcome, ifVersion: cached ? cached.version : 0 });
    } catch {
      const winner = await mesh.get<ItemOutcome>({ key });
      if (winner && winner.value.status === "completed") return winner.value;
    }
    return outcome;
  }),
  { concurrency: 8 },
);

const completed = outcomes.filter((o) => o.status === "completed");
const failures = outcomes.filter((o) => o.status === "failed");
await workflow.event({
  message: `${completed.length}/${items.length} complete (${replayed} replayed from journal, ${failures.length} failed)`,
  level: failures.length === 0 ? "success" : "warning",
});

return {
  status: failures.length === 0 ? "success" : "partial",
  runKey: π.runKey,
  coverage: { requested: items.length, completed: completed.length, replayed },
  failures,
  results: completed.map(({ item, finding }) => ({ item, finding })),
};
```

A `partial` result must not trigger an automatic whole-run rerun — the journal already makes retry surgical: invoking the same program with the same `strings.runKey` re-attempts exactly the failed items (failed entries are never replayed) and replays everything else at zero cost. This is the content-keyed alternative to positional journaling: position-indexed caches invalidate everything downstream of an edit, while identity+hash keys localize invalidation to the items whose prompt actually changed — the trade-off is that the journal only helps work expressible as keyed items.

The journal is durable project state under `resume/<runKey>/…` — clear it with `strings.fresh` when the underlying repository has changed enough that old findings are stale, and prefer a new `runKey` per distinct objective so unrelated runs never share entries. Discovery must be deterministic for resume to converge: derive the item list from the world, never from model invention. Add a verification phase downstream (see `/skill:fabric-workflow` — recommend it for the user to invoke; do not invoke another user-only skill yourself) when findings feed decisions.
