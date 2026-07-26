---
name: fabric-postmortem
description: Turns a run's surprises and failures into a durable, self-curating field guide on the mesh — a stigmergic memory that future runs read at start. Reads real transcripts, diagnoses patterns, and deposits strategy-level tips under a budgeted key that forces weak tips to evaporate. Use after a run with failures, surprises, retries, or budget overruns; the guide compounds across sessions.
disable-model-invocation: true
---

# Fabric Postmortem

Trace-derived steering is empirically potent: reading an agent system's trajectories and feeding a short model-written tips prompt back into it has repeatedly produced double-digit accuracy jumps with zero training. Fabric retains the raw material — every run's transcript, readable via `agents.log`, plus the cross-session memory index — and the mesh gives a field guide a durable home. This skill is a stigmergic loop: collect evidence → diagnose patterns → deposit tips into a budgeted field guide that future runs read at start.

Model it as a pheromone field, and the three rules that make swarm memory work rather than rot fall out (Bonabeau/Dorigo/Theraulaz; and Cursor's "Field Guide", 2026):

- **Deposit on surprise, not on volume.** Weights are frozen, so what's worth capturing is the *unexpected* — the gotcha, the counterintuitive fix, the assumption that broke — because only surprises shorten the next trajectory. Failures are the cheapest surprises to detect, but a surprising *success* is a deposit too. Capturing every routine event just dilutes the field.
- **The budget is the evaporation term.** The tip list has a hard cap; the distill step must overwrite the weakest tips to stay under it. Without evaporation the field stagnates on early consensus (the formal swarm result: amplification with no decay converges the whole colony on one sub-optimal path). The cap is not tidiness — it is what keeps the guide alive.
- **Reality-couples the deposits.** The transcript is the source of truth; tips are disposable views. A tip earns its place from tool evidence — a command that ran, a build that broke, a test that flipped — never from an agent's assertion, and a tip that stops matching reality is deleted, never defended. Tips are strategy, not answers: "verify sub-agent results before building on them" compounds; "the bug was in parser.ts" is stale the moment it lands.

Pass `strings.scope` (one sentence: what ran and what went wrong), `strings.lessonsKey` (a stable domain name, e.g. "code-review" — future runs read `lessons/<key>`), and optionally `strings.workerIds` (JSON array of agent ids from the prior run's envelope, same session; when absent the memory index is mined instead).

```ts
type Diagnosis = { patterns: Array<{ pattern: string; evidence: string; tip: string }> };
type Lessons = { tips: string[]; updatedFor: string };

await workflow.configure({
  name: "Postmortem",
  description: `diagnose failures → steering tips under lessons/${π.lessonsKey}`,
});

// Collect: transcripts by id when the caller kept them; otherwise mine the
// memory index for recent failed operations.
await phase("Collect", { total: 1 });
const evidence: Array<{ source: string; detail: string }> = [];
if (π.workerIds) {
  const ids = JSON.parse(π.workerIds) as string[];
  for (const id of ids.slice(0, 12)) {
    const entry = await agents.log({ id, lines: 1 });
    const file = "logFile" in entry ? entry.logFile : entry.sessionFile;
    evidence.push({ source: id, detail: file });
  }
} else {
  const recall = await memory.recall({ outcome: "failed", pageSize: 30 });
  evidence.push({
    source: "memory-index",
    detail: recall.text ?? JSON.stringify(recall.items ?? []).slice(0, 8000),
  });
}
if (evidence.length === 0) {
  return { status: "failed", lessonsKey: π.lessonsKey, reason: "no evidence to analyze" };
}

// Diagnose: one fresh-context analyst per evidence source, reading the real
// transcript — the agent's own prose is not evidence, tool activity is.
await phase("Diagnose", { total: evidence.length });
const diagnoses = await parallel(
  evidence.map((e) => async () => {
    try {
      return await agent<Diagnosis>(
        `You are analyzing why an agent run underperformed. Scope: ${π.scope}\n\n` +
          (e.source === "memory-index"
            ? `Below is an index of failed operations from recent sessions:\n${e.detail}`
            : `The full run transcript for agent ${e.source} is at:\n${e.detail}\n(JSONL — grep for tool calls, errors, and results; judge from tool activity, not the agent's own narration.)`) +
          `\n\nIdentify recurring FAILURE PATTERNS: behaviors that wasted work or produced wrong results (e.g. brute-force loops that timed out, unverified sub-results built upon, re-reading the same files, claims without tool evidence, missing error handling for a specific tool). Before keeping a cause, pressure-test it against the evidence: is it sufficient, or are there missing co-causes? is there an independent additional cause you're overlooking? and most important — if this cause is real, what ELSE must the transcript show? Derive that consequence and confirm it in the trace; a cause with no corroborating consequence is a guess, not a finding, so drop it. Keep only causes that survive. For each survivor: the pattern, verbatim evidence, and ONE actionable steering tip a future prompt could carry. Tips must be strategy-level and reusable — never task-specific facts, file names as answers, or anything secret.`,
        {
          label: `diagnose ${e.source}`.slice(0, 50),
          tools: ["read", "grep"],
          thinking: "high",
          schema: {
            type: "object",
            properties: {
              patterns: {
                type: "array",
                maxItems: 6,
                items: {
                  type: "object",
                  properties: {
                    pattern: { type: "string" },
                    evidence: { type: "string" },
                    tip: { type: "string" },
                  },
                  required: ["pattern", "evidence", "tip"],
                  additionalProperties: false,
                },
              },
            },
            required: ["patterns"],
            additionalProperties: false,
          },
        },
      );
    } catch {
      return { patterns: [] };
    }
  }),
  { concurrency: 4 },
);
const found = diagnoses.flatMap((d) => d.patterns);
if (found.length === 0) {
  return { status: "success", lessonsKey: π.lessonsKey, added: 0, tips: [], note: "no recurring patterns found" };
}

// Distill: merge with existing lessons — dedup, drop stale, cap the list.
// Lessons are a disposable view; the cap forces erasure of weak tips.
await phase("Distill", { total: 1 });
const key = `lessons/${π.lessonsKey}`;
const existing = await mesh.get<Lessons>({ key });
const merged = await agent<Lessons>(
  `Merge new steering tips into an existing lesson list for future agent runs in this domain.\n\nDomain: ${π.lessonsKey}\nScope of this postmortem: ${π.scope}\n\nExisting tips:\n${JSON.stringify(existing?.value.tips ?? [])}\n\nNew candidate tips (with the patterns they came from):\n${JSON.stringify(found)}\n\nRules: deduplicate aggressively (same lesson, different words = one tip); each tip is one imperative sentence, strategy-level, reusable, vendor- and model-agnostic; drop existing tips this evidence contradicts; keep the strongest 12 or fewer — a long list steers nothing.`,
  {
    label: "distill lessons",
    thinking: "xhigh",
    schema: {
      type: "object",
      properties: {
        tips: { type: "array", maxItems: 12, items: { type: "string" } },
        updatedFor: { type: "string" },
      },
      required: ["tips", "updatedFor"],
      additionalProperties: false,
    },
  },
);
await mesh.put({ key, value: merged, ifVersion: existing ? existing.version : 0 });

return {
  status: "success",
  lessonsKey: key,
  added: found.length,
  total: merged.tips.length,
  tips: merged.tips,
};
```

**Auto-injection is the caller's half — the field guide only works if the environment shapes the next agent.** Future orchestrations in this domain read the guide before spawning workers and prepend it to every worker prompt at start; this is the stigmergic loop closing (the environment shaping the next organism), not an optional lookup:

```ts
const lessons = await mesh.get<{ tips: string[] }>({ key: `lessons/${π.lessonsKey}` });
const steering = lessons && lessons.value.tips.length > 0
  ? `Field guide from prior runs (heed before starting):\n- ${lessons.value.tips.join("\n- ")}\n\n`
  : "";
// prepend `steering` to each worker prompt
```

Run a postmortem after a run with failures, surprising cost, partial coverage, or a genuinely surprising outcome — not after every routine clean run (a guide fed only unremarkable events converges to platitudes). Keep one `lessonsKey` per genuine domain; a catch-all key produces catch-all tips. Forgetting is deliberate: when a tip stops earning its place, the distill step's cap and contradiction rule evaporate it, and the transcripts remain if it must ever be re-derived.
