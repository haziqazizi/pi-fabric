---
name: fabric-orchestrate
description: Delegates orchestration itself to a fresh recursive child — the bloated main session writes only a compact brief; a clean-context child authors and runs the multi-agent program and returns a compact envelope. Use late in long sessions, or for self-contained campaigns, when the main context is no longer the right place to write careful orchestration code.
disable-model-invocation: true
---

# Fabric Orchestrate

Every fabric program keeps its *workers* in clean, focused contexts — but the program itself is authored by the main session, which late in a long conversation is the most bloated context in the system. Orchestration written from that seat inherits its noise: stale assumptions, leftover vocabulary, attention spread across a hundred turns. The fix is the same move fabric already applies to everything else, applied once more: **offload the authoring**. The main session distills the task into a compact brief; a fresh recursive child (a full Pi session with fabric enabled) plans, writes, and runs the orchestration from a clean seat; only a compact envelope returns.

Use it when the main context is long and the campaign is self-contained (a bounded audit, migration, research sweep). Do not use it early in a fresh session (the indirection buys nothing), for work needing mid-flight conversation with the user, or nested inside another orchestrate call — recursion depth is capped and one level of delegated authorship is the point.

**The brief is everything.** The child sees only what you write — that is the feature, not a limitation. A good brief carries the goal, the constraints and boundaries, what "done" looks like, any steering tips from prior runs, and nothing else: no chat history, no working vocabulary the child would have to decode.

Pass `strings.task` (the goal), `strings.constraints` (boundaries, budgets, what must not happen), and `strings.done` (checkable completion criteria).

```ts
type Envelope = {
  status: "success" | "partial" | "failed";
  result: string;
  coverage: string;
  failures: string[];
};

await workflow.configure({
  name: "Delegated orchestration",
  description: "clean-context child authors and runs the campaign",
});

// Include lessons from prior runs in the brief when they exist — the child
// starts clean, so durable steering must travel in the brief.
const lessons = await mesh.get<{ tips: string[] }>({ key: "lessons/orchestrate" });
const steering = lessons && lessons.value.tips.length > 0
  ? `\n\nSteering from prior runs:\n- ${lessons.value.tips.join("\n- ")}`
  : "";

await phase("Delegate", { total: 1 });
const outcome = await rlm.query({
  name: "orchestrator",
  task:
    `You are a fresh orchestrator with fabric available. Plan and execute this campaign with a code-mode orchestration program: decompose into bounded items, fan out focused sub-agents (each call small and specific; move data through variables and files, not through your own context), verify findings adversarially before trusting them, and track failures explicitly instead of dropping them.\n\n` +
    `GOAL:\n${π.task}\n\n` +
    `CONSTRAINTS:\n${π.constraints}\n\n` +
    `DONE MEANS:\n${π.done}${steering}\n\n` +
    `Return only a compact envelope: overall status (success/partial/failed), the result, what was covered, and named failures. Do not return raw intermediate output.`,
  schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["success", "partial", "failed"] },
      result: { type: "string" },
      coverage: { type: "string" },
      failures: { type: "array", items: { type: "string" } },
    },
    required: ["status", "result", "coverage", "failures"],
    additionalProperties: false,
  },
});

const envelope = outcome.value as Envelope | undefined;
if (!envelope) {
  return {
    status: "failed",
    result: null,
    error: outcome.error ?? "child returned no structured envelope",
    fallbackText: outcome.text.slice(0, 4000),
  };
}
return { ...envelope, childId: outcome.id, usage: outcome.usage };
```

The child consumes real budget — it is a full session tree, bounded by the configured recursion depth, per-execution agent caps, and the shared cost ledger; state its budget expectations in `strings.constraints` so the child paces itself. A `partial` envelope is usable evidence with named gaps and must not trigger an automatic whole-campaign rerun — retry only the named failures, or send the child a follow-up. The child's id returns in the envelope, so its transcript remains auditable via `agents.log` after the fact; keep the campaign honest by auditing before acting on surprising claims. When the session is fresh or the task needs the user in the loop, skip the indirection and orchestrate directly.
