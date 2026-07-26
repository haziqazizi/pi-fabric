---
name: fabric-workflow
description: Runs a dynamic Pi Fabric workflow with code-held phases, fan-out, pipelines, structured agents, and best-effort verification. Use for large audits, migrations, parallel research, or explicit workflow requests.
disable-model-invocation: true
---

# Fabric Dynamic Workflow

Put the complete loop, phases, and branches in one type-checked `fabric_exec` program. Pass the objective as `strings.task`.

Core surfaces:

- `agent(prompt, { label, tools?, schema?, ... })` for a bounded worker; label every call.
- `parallel(thunks, { concurrency })` for fan-out; pass functions, not promises.
- `pipeline(items, ...stages)` for sequential stages per item with cross-item concurrency.
- `workflow.configure`, `phase`, `workflow.item`, `workflow.event`, and `workflow.log` for dashboard progress.
- `workflow.budget` plus top-level `agentBudget`/`tokenBudget` for bounded runs.

Use JSON Schema when machine-readable output makes aggregation safer. A reliable shape is discover → analyze in checked batches → verify available findings:

```ts
type WorkOutcome =
  | { item: string; status: "completed"; finding: string }
  | { item: string; status: "failed" | "not_started"; error: string };

await workflow.configure({
  name: "Request analysis",
  description: "Discover, analyze, and verify bounded work items",
});
await phase("Discover", { total: 1 });
const inventory = await agent<{ items: string[] }>(
  `Discover the bounded work items for this objective.\n\nObjective:\n${π.task}`,
  {
    label: "inventory",
    tools: ["read", "grep", "find", "ls"],
    thinking: "low", // discovery is mechanical — route effort to analysis and verification
    schema: {
      type: "object",
      properties: {
        items: { type: "array", maxItems: 32, items: { type: "string" } },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
);
const items = [...new Set(inventory.items.map((item) => item.trim()).filter(Boolean))];
if (items.length === 0) {
  return {
    status: "success",
    coverage: { requested: 0, completed: 0 },
    failures: [],
    result: "No bounded work items were found.",
  };
}

await phase("Analyze", { total: items.length });
const outcomes: WorkOutcome[] = [];
const batchSize = 8;
for (let offset = 0; offset < items.length; offset += batchSize) {
  const batch = items.slice(offset, offset + batchSize);
  const settled = await parallel(
    batch.map((item) => async (): Promise<WorkOutcome> => {
      try {
        const finding = await agent(
          `Analyze this bounded item: ${item}\n\nObjective:\n${π.task}\n\nCite verbatim evidence from tool output for every claim; only report what you can point to evidence for, and mark anything unverified as unverified.`,
          {
            label: `analyze ${item}`.slice(0, 50),
            tools: ["read", "grep", "find", "ls"],
          },
        );
        return { item, status: "completed", finding };
      } catch (error) {
        return {
          item,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
    { concurrency: batch.length },
  );
  outcomes.push(...settled);
  if (settled.every((outcome) => outcome.status === "failed")) {
    outcomes.push(...items.slice(offset + batch.length).map((item): WorkOutcome => ({
      item,
      status: "not_started",
      error: "not started after an all-failed batch",
    })));
    break;
  }
}

const completed = outcomes.filter(
  (outcome): outcome is Extract<WorkOutcome, { status: "completed" }> =>
    outcome.status === "completed",
);
const failures = outcomes.filter(
  (outcome): outcome is Extract<WorkOutcome, { status: "failed" | "not_started" }> =>
    outcome.status !== "completed",
);
const coverage = { requested: items.length, completed: completed.length };
if (completed.length === 0) {
  return { status: "failed", coverage, failures, result: null };
}

await phase("Verify", { total: 1 });
try {
  const result = await agent(
    `You are a verifier with fresh context; you did not produce these findings. For each completed finding, actively try to refute it: re-check its cited evidence against the actual files. Label each finding CONFIRMED (you reproduced its evidence), PLAUSIBLE (consistent with the code but not directly reproduced), or REFUTED (evidence wrong or missing — drop it). Do not force a binary call; PLAUSIBLE is a valid verdict the reader will hedge on. Do not infer anything about failed items. Return confirmed and plausible findings with their evidence, and list what you refuted and why.\n\nObjective:\n${π.task}\n\nFindings:\n${JSON.stringify(completed)}`,
    { label: "verify synthesis", tools: ["read", "grep", "find", "ls"], thinking: "xhigh" },
  );
  await workflow.event({ message: "Verification complete", level: "success" });
  return {
    status: failures.length === 0 ? "success" : "partial",
    coverage,
    failures,
    result,
  };
} catch (error) {
  return {
    status: "partial",
    coverage,
    failures,
    result: null,
    verificationError: error instanceof Error ? error.message : String(error),
    fallback: completed,
  };
}
```

Route effort per stage role via `thinking`: `low` for mechanical discovery, the default for analysis, `xhigh` for verification — the verifier is the gate everything else depends on, so it is the one place not to economize. For high-stakes findings, replace the single verifier with 2–3 refuters (`parallel`) and keep only findings a majority fail to refute. The verifier must always be a fresh context, never an agent that produced the findings.

Adapt phases and tools to the request. For edits, partition path ownership or use `worktree: true`; never let concurrent workers edit the same files. Successful verification returns compact output; raw findings return only if verification fails. `partial` is usable and must not trigger an automatic whole-workflow rerun—retry only failed items when their coverage matters.

Use `agents.spawn` plus `status`/`steer` instead of blocking `agent()` only when a valuable long-running worker must be observed and redirected between turns. Inventory is capped and checked batches stop new work after a systemic all-failed batch. Concurrent calls can still overshoot observational budgets because usage settles afterward.
