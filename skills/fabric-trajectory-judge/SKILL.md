---
name: fabric-trajectory-judge
description: Runs a worker and then grades its process, not just its artifact — a fresh-context judge checks every claim the worker made against the actual run transcript (tool calls and results), so fabricated evidence, skipped verification, and unread citations get caught. Use for long or high-stakes delegated work where "done" claims must be trusted.
disable-model-invocation: true
---

# Fabric Trajectory Judge

Artifact grading trusts the worker's self-report; a plausible artifact plus a fabricated "all tests pass" survives it. Fabric retains every run's transcript (`events.jsonl` in the run directory, readable in-program via `agents.log`), which enables the stronger check: judge the **trajectory**. The worker must attach evidence claims to its result; a fresh-context judge then verifies each claim against tool events actually recorded in the transcript — evidence captured at the system boundary, outside the worker's control. A claim with no supporting tool event is refuted no matter how confident the prose.

Use one `fabric_exec` call. Pass the assignment as `strings.task`. Spawn the worker with `agents.spawn` (not `agent()`) so its id and log survive for judging.

```ts
type Claim = { claim: string; kind: "action" | "verification" | "citation" };
type WorkerOutput = { result: string; claims: Claim[] };
type ClaimVerdict = { claim: string; supported: boolean; evidence: string };

await workflow.configure({
  name: "Trajectory-judged run",
  description: "worker → transcript → per-claim verification",
});

await phase("Work", { total: 1 });
const handle = await agents.spawn({
  name: "worker",
  task:
    `${π.task}\n\n` +
    `Alongside your result, list every material claim you are making about what you did — actions taken, things you verified, sources you read. One claim per entry. ` +
    `Only claim work you actually performed with tools in this session; if something is not verified, do not claim it as verified.`,
  schema: {
    type: "object",
    properties: {
      result: { type: "string" },
      claims: {
        type: "array",
        maxItems: 24,
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            kind: { type: "string", enum: ["action", "verification", "citation"] },
          },
          required: ["claim", "kind"],
          additionalProperties: false,
        },
      },
    },
    required: ["result", "claims"],
    additionalProperties: false,
  },
});
const outcome = await agents.wait({ id: handle.id });
const output = outcome.value as WorkerOutput | undefined;
if (!output) {
  return { status: "failed", result: null, error: outcome.error ?? "worker returned no structured output" };
}

// The transcript is the ground truth: tool calls and results recorded by the
// host, outside the worker's control.
const log = await agents.log({ id: handle.id, lines: 1 });
const transcriptFile = "logFile" in log ? log.logFile : log.sessionFile;

await phase("Judge", { total: output.claims.length || 1 });
const verdicts = await parallel(
  output.claims.map((c) => async (): Promise<ClaimVerdict & { kind: Claim["kind"] }> => {
    const v = await agent<ClaimVerdict>(
      `You are auditing another agent's run. You have its full transcript at:\n${transcriptFile}\n` +
        `(JSONL; each line is a session event — grep for tool names, commands, file paths, and outputs.)\n\n` +
        `Verify exactly one claim the agent made about its own work. The claim is SUPPORTED only if the transcript contains tool events that actually perform or verify it — a command that ran, a file that was read, output that matches. ` +
        `The agent's own prose in the transcript is NOT evidence; only tool activity and tool results count. When you cannot find supporting events, the claim is unsupported — default to unsupported when uncertain. Quote the matching transcript lines verbatim as evidence.\n\n` +
        `Claim (${c.kind}): ${c.claim}`,
      {
        label: `audit: ${c.claim}`.slice(0, 50),
        tools: ["read", "grep"],
        thinking: "xhigh",
        schema: {
          type: "object",
          properties: {
            claim: { type: "string" },
            supported: { type: "boolean" },
            evidence: { type: "string" },
          },
          required: ["claim", "supported", "evidence"],
          additionalProperties: false,
        },
      },
    );
    return { ...v, claim: c.claim, kind: c.kind };
  }),
  { concurrency: 4 },
);

const refuted = verdicts.filter((v) => !v.supported);
const confirmed = verdicts.filter((v) => v.supported);
return {
  status: refuted.length === 0 ? "success" : "contested",
  result: output.result,
  audit: {
    workerId: handle.id,
    transcript: transcriptFile,
    claims: output.claims.length,
    confirmed: confirmed.length,
    refuted: refuted.map((v) => ({ claim: v.claim, kind: v.kind })),
  },
};
```

`contested` means the artifact may still be fine but specific claims about it are unverified — treat exactly those claims as untrue until re-established (re-run the verification yourself, or send the worker a follow-up demanding the tool call), and never launder a contested result into a clean "done". Refuted `verification` claims are the serious class: they are how "tests pass" ships broken work.

Cost is one worker plus one auditor call per claim (cap claims via the schema's `maxItems`; batch to one auditor over all claims for cheap runs, at some recall cost). The judge is honest only while it stays fresh-context: never let the worker audit itself, and give auditors `read`/`grep` only — they check evidence, they don't create it. Transcripts live under the fabric run root and are subject to retention cleanup; judge promptly after `wait` rather than in a later execution. Claude-runner workers (`runner: "claude"`) also record transcripts, so the pattern works across runners.
