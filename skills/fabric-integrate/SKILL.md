---
name: fabric-integrate
description: Merges the branches from a worktree fan-out with a neutral third-party resolver — an impartial agent that resolves each conflict on behalf of all parties, then a reality-coupled build/test gate confirms the integration. Use after parallel worktree-isolated editors produce competing branches that must become one tree.
disable-model-invocation: true
---

# Fabric Integrate

Parallel editors in isolated worktrees (`isolation: "worktree"`) never overwrite each other — but their branches still have to become one tree, and leaving that to a human, or to one of the authoring agents, is where fan-out edits go wrong. An authoring agent resolving a conflict favors its own side; a worker asked to merge either clobbers the other change or abandons its own. The fix, from production swarms merging at scale: a **neutral third-party resolver** whose only goal is to be impartial and efficient, exactly like a merge queue — it wrote neither side, so it has no side to favor. The integration is then confirmed by a **reality-coupled gate** (the build/tests), not by anyone's say-so.

Pass `strings.branches` (JSON array of branch names from the fan-out), `strings.verify` (a shell command that must exit 0 — the build/test gate; the merge is not "done" until this passes), `strings.base` (branch to integrate onto; defaults to current HEAD), and `strings.integrationBranch` (name for the result).

```ts
type Resolution = { resolved: string; note: string };

const branches = (JSON.parse(π.branches) as string[]).map((b) => b.trim()).filter(Boolean);
if (branches.length === 0) throw new Error("No branches to integrate.");
const integrationBranch = π.integrationBranch || "fabric-integration";

await workflow.configure({
  name: "Neutral integration",
  description: `merge ${branches.length} branches → resolver → verify`,
});

const sh = async (command: string) => {
  const r = await pi.bash({ command });
  return { ok: r.ok, output: r.output };
};

// Establish the integration branch off the base.
await phase("Setup", { total: 1 });
const base = π.base || (await sh("git rev-parse --abbrev-ref HEAD")).output.trim();
await sh(`git checkout -B ${integrationBranch} ${base}`);

await phase("Merge", { total: branches.length });
const merged: string[] = [];
const conflicts: Array<{ branch: string; file: string; note: string }> = [];
const failed: Array<{ branch: string; error: string }> = [];

for (const branch of branches) {
  const attempt = await sh(`git merge --no-ff --no-edit ${branch}`);
  if (attempt.ok) {
    merged.push(branch);
    continue;
  }
  // Conflict (or merge error). Collect conflicted paths; a non-conflict error aborts this branch.
  const status = await sh("git diff --name-only --diff-filter=U");
  const files = status.output.split("\n").map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) {
    await sh("git merge --abort");
    failed.push({ branch, error: attempt.output.slice(0, 500) });
    continue;
  }
  // Resolve each conflicted file with a neutral resolver — it authored neither side.
  const resolutions = await parallel(
    files.map((file) => async () => {
      const withMarkers = await pi.read({ path: file });
      const res = await agent<Resolution>(
        `You are a NEUTRAL third-party merge resolver. You did not write either side of this conflict and have no side to favor; your only goal is a correct, minimal, buildable merge.\n\n` +
          `The file below contains git conflict markers (<<<<<<<, =======, >>>>>>>). Return the FULLY resolved file content with every marker removed, preserving the intent of BOTH sides wherever they are compatible. When the two sides genuinely cannot both hold, keep the change that is consistent with the rest of the file and note the trade-off. Do not add features neither side had.\n\nFile: ${file}\n\n${withMarkers}`,
        {
          label: `resolve ${file}`.slice(0, 50),
          thinking: "high",
          schema: {
            type: "object",
            properties: { resolved: { type: "string" }, note: { type: "string" } },
            required: ["resolved", "note"],
            additionalProperties: false,
          },
        },
      );
      await pi.write({ path: file, content: res.resolved });
      await sh(`git add ${file}`);
      return { file, note: res.note };
    }),
  );
  const commit = await sh(`git commit --no-edit`);
  if (commit.ok) {
    merged.push(branch);
    for (const r of resolutions) conflicts.push({ branch, file: r.file, note: r.note });
  } else {
    await sh("git merge --abort");
    failed.push({ branch, error: commit.output.slice(0, 500) });
  }
}

// Reality-coupled gate: the integration is not done until the build/tests pass.
await phase("Verify", { total: 1 });
let verify = await sh(π.verify);
let fixNote = "";
if (!verify.ok) {
  // One neutral fix pass against the actual failure output, then re-gate.
  const fix = await agent(
    `The merged tree fails its verification gate. You are a neutral integrator, not an author of any branch. Diagnose and apply the MINIMAL fix that makes the gate pass without reverting anyone's intended change; if a change is fundamentally incompatible, say so rather than papering over it.\n\nGate command: ${π.verify}\n\nFailure output:\n${verify.output.slice(0, 4000)}`,
    { label: "integration fix", tools: ["read", "grep", "edit", "write", "bash"], thinking: "xhigh" },
  );
  fixNote = fix;
  verify = await sh(π.verify);
}

return {
  status: verify.ok ? (failed.length === 0 ? "success" : "partial") : "failed",
  integrationBranch,
  merged,
  conflictsResolved: conflicts,
  failedBranches: failed,
  gate: { command: π.verify, passed: verify.ok, output: verify.ok ? "" : verify.output.slice(0, 2000) },
  ...(fixNote ? { fixApplied: fixNote } : {}),
};
```

The resolver's neutrality is the whole point — never let a branch's own author resolve its conflicts (they favor their side; this is writer-never-grades applied to merging), and give the resolver only the conflicted file, not the authors' arguments. The gate is what makes the result trustworthy: a merge that resolves cleanly but breaks the build is not integrated, so `strings.verify` should be a real build/test command, not a lint. A `failed` status means the tree does not build after best-effort resolution — surface it; do not report a broken integration as done. `bash` and `write` need execute/write approval; run this only on branches from a fan-out you initiated. For choosing *which* competing implementation wins rather than merging complementary edits, use `/skill:fabric-select` instead (recommend it for the user to invoke; do not invoke another user-only skill yourself).
