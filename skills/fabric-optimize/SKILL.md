---
name: fabric-optimize
description: Iteratively improves one artifact against an explicit rubric — fresh-context generator each round, isolated per-criterion grading, champion tracking so a later worse attempt can never ship, and a hard iteration cap. Use when output quality against known criteria matters more than latency.
disable-model-invocation: true
---

# Fabric Optimize

Use one `fabric_exec` call to run a bounded generate → grade → revise loop. Three rules make the loop converge instead of thrash: the grader is isolated (a fresh agent grading one criterion per call — never the generator critiquing itself); each revision goes to a **fresh generator** that receives the previous attempt plus per-criterion feedback, rather than asking the author to defend its own work; and a **champion** — the best-scoring attempt so far — is tracked in code, so the loop returns the best attempt, not the last one.

Pass `strings.task` (what to produce, with enough intent that the generator can resolve ambiguities), `strings.rubric` as a JSON array of atomic yes/no criteria (2–10; one constraint each — split anything with "and"), and optionally `strings.maxIterations` (default 4, hard cap 8).

```ts
type Grade = { pass: boolean; feedback: string; evidence: string };
type Attempt = { iteration: number; artifact: string; passed: number; grades: Array<Grade & { criterion: string }> };

const rubric = JSON.parse(π.rubric) as string[];
if (rubric.length < 2 || rubric.length > 10) throw new Error("Rubric needs 2–10 atomic criteria.");
const maxIterations = Math.min(Number(π.maxIterations || 4), 8);

await workflow.configure({
  name: "Evaluator-optimizer",
  description: `${rubric.length}-criterion rubric, up to ${maxIterations} iterations, champion returned`,
});

let champion: Attempt | null = null;
let feedbackForNext = "";

for (let iteration = 0; iteration < maxIterations; iteration++) {
  await phase(`Iteration ${iteration + 1}`, { total: rubric.length + 1 });

  // Fresh generator each round — it sees the prior attempt and the graders'
  // feedback, but it is not the author being asked to defend its work.
  const artifact = await agent(
    `Produce the artifact described below.` +
      (feedbackForNext
        ? `\n\nA previous attempt and per-criterion feedback follow. Fix every failed criterion without breaking the passing ones; keep what worked.\n${feedbackForNext}`
        : "") +
      `\n\nTask:\n${π.task}`,
    { label: `generate #${iteration + 1}`, tools: ["read", "grep", "find", "ls"] },
  );

  // Isolated grading: one criterion per call, aggregated in code.
  const grades = await parallel(
    rubric.map((criterion) => async () => ({
      criterion,
      ...(await agent<Grade>(
        `Grade exactly one criterion against the artifact. pass/fail only; when uncertain, fail. Quote verbatim evidence from the artifact, and if it fails, give one concrete, actionable fix — not a restatement of the criterion.\n\nCriterion: ${criterion}\n\nArtifact:\n${artifact}`,
        {
          label: `grade: ${criterion}`.slice(0, 50),
          thinking: "xhigh",
          schema: {
            type: "object",
            properties: {
              pass: { type: "boolean" },
              feedback: { type: "string" },
              evidence: { type: "string" },
            },
            required: ["pass", "feedback", "evidence"],
            additionalProperties: false,
          },
        },
      )),
    })),
    { concurrency: rubric.length },
  );

  const passed = grades.filter((g) => g.pass).length;
  const attempt: Attempt = { iteration: iteration + 1, artifact, passed, grades };
  if (!champion || passed > champion.passed) champion = attempt; // strict > : first best wins ties, no churn
  await workflow.event({
    message: `Iteration ${iteration + 1}: ${passed}/${rubric.length} criteria pass (champion: ${champion.passed})`,
    level: passed === rubric.length ? "success" : "info",
  });

  if (passed === rubric.length) break;

  feedbackForNext =
    `Previous attempt:\n${artifact}\n\nGrades:\n` +
    grades
      .map((g) => `- [${g.pass ? "PASS" : "FAIL"}] ${g.criterion}${g.pass ? "" : ` — ${g.feedback}`}`)
      .join("\n");
}

if (!champion) return { status: "failed", artifact: null, reason: "no iterations ran" };
return {
  status: champion.passed === rubric.length ? "success" : "partial",
  artifact: champion.artifact,
  iteration: champion.iteration,
  score: { passed: champion.passed, total: rubric.length },
  failedCriteria: champion.grades.filter((g) => !g.pass).map((g) => ({ criterion: g.criterion, feedback: g.feedback })),
};
```

Cost per iteration is one generator call plus one grader call per criterion; reserve `maxIterations × (rubric.length + 1)` agent calls. A `partial` result is the best attempt with its named gaps — usable, and not grounds for an automatic rerun; if a specific criterion keeps failing across iterations, the criterion is likely ambiguous or the task under-specified — fix the rubric or the task, don't add iterations. Refinement past sufficiency degrades output: when the champion passes everything, stop, even with budget left.

Calibrate the rubric before trusting a long run: grade one known-good and one known-bad artifact first — a rubric that passes both is a rubber stamp. When the need is choosing among independently generated candidates rather than refining one, recommend `/skill:fabric-select` for the user to invoke; do not invoke another user-only skill yourself.
