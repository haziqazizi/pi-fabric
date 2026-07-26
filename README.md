# pi-fabric (fork)

> A fork of **[monotykamary/pi-fabric](https://github.com/monotykamary/pi-fabric)** — one `fabric_exec` tool that lets the [Pi](https://github.com/earendil-works/pi-coding-agent) coding agent write type-checked TypeScript against its own capabilities, instead of orchestrating one tool call at a time. All credit for the runtime foundation goes to Tom ([@monotykamary](https://github.com/monotykamary)); read the [upstream README](https://github.com/monotykamary/pi-fabric) for the origin story and core architecture.

This fork layers two things on top of upstream: **runtime hardening** (tiering, budgets, structured-output repair, journaled replay, program linting) and a **library of dynamic-workflow skill patterns**. Everything here stays **vendor-neutral** — Pi runs many models at many reasoning levels, so nothing couples to a specific provider or hardcodes model IDs; reasoning depth flows only through Pi's generic effort/thinking levels.

The design principles behind all of it live in the companion doctrine repo, **[designing-dynamic-workflows](https://github.com/haziqazizi/designing-dynamic-workflows)**.

---

## Runtime improvements (`src/`)

Six additions to the core runtime, each model-agnostic and test-covered (full suite green, 1,165 tests):

| Feature | What it does |
|---|---|
| **Model tiers** | `tier: "small" \| "medium" \| "big"` on any agent call, resolved against the user's *actual* configured models by **price-first ranking** — robust to novel vendor names, with no-collapse/no-inversion guards and no hardcoded model IDs. Route cheap work to cheap models without naming them. |
| **Bounded schema repair** | When a subagent with a JSON schema never emits valid structured output, the worker re-prompts the live session up to `maxSchemaRetries` times, then tries strict host-side extraction, then fails with a terminal `schema_noncompliance` error that **bypasses retries by design** (a retry just repeats the failure at full cost). |
| **Reserve-then-settle budgets** | The cost ledger now reserves an estimate at spawn and settles the actual on completion, closing the concurrent-spawn overshoot race. New `budgetEnforcement: "hard"` stops running children once settled + reserved reaches the ceiling; `"soft"` (default) preserves exact current behavior. |
| **Quality-pattern helpers** | `verify`, `judgePanel`, `loopUntilDry`, and `gate` as guest globals — adversarial-vote verification, judge panels, loop-until-dry discovery, and bounded semantic retry — with **visible-failure semantics** (exhaustion is returned, never thrown away or dressed up as success). |
| **Journaled replay** | Opt-in `journalKey` on `fabric_exec` gives **content-keyed** resume: re-running replays completed agent results and re-pays only for new or changed calls. A determinism guard (throw on `Math.random`/`Date.now` when journaling) makes replay sound — and is inert when journaling is off. |
| **LID lint** | Advisory type-check warnings (never fatal) when an authored program inlines an oversized prompt or collapses to a single undecomposed agent call — nudging programs toward small, locally-in-distribution calls. |

## Skill patterns (`skills/`)

Advanced multi-agent patterns as user-invoked skills, each a type-checked `fabric_exec` program. Invoke `/skill:fabric-guide` to have it recommend the smallest sufficient one.

- **fabric-workflow** — discover → fan-out → verify, with per-role effort routing and three-way (confirmed / plausible / refuted) verification verdicts
- **fabric-council** — a reviewer panel differentiated *structurally* (different briefs, evidence, tools), not by persona labels
- **fabric-fusion** — a cross-provider model panel with judge-bias guards (the judge is pulled from outside the panel where possible)
- **fabric-select** — the selection ladder: external check → order-swapped pairwise → per-criterion veto → graft the losers' best parts
- **fabric-optimize** — an evaluator-optimizer loop with champion tracking and fresh-context retry, so a later worse attempt can't ship
- **fabric-trajectory-judge** — audits an agent's *process* against its run transcript, catching fabricated evidence and unverified "done" claims
- **fabric-resume** — a content-keyed journaled fan-out that survives interruption and re-pays only for changed items
- **fabric-postmortem** — a self-curating "field guide": stigmergic memory that turns a run's surprises into durable, budget-capped steering the next run reads
- **fabric-orchestrate** — delegates orchestration authorship to a fresh recursive child, keeping the author call locally-in-distribution late in long sessions
- **fabric-integrate** — a neutral third-party resolver that merges the branches from a worktree fan-out behind a build/test gate
- **fabric-guide** — a router that recommends the smallest sufficient pattern and never runs it

## Install

This is still pi-fabric. For the base runtime and its published package, see the [upstream README](https://github.com/monotykamary/pi-fabric). To run this fork's additions, clone this repo, build from source (`pnpm install`, then the package build scripts), and install the local extension into Pi.

## Relationship to upstream

A **divergent fork**, maintained independently. It may pull upstream fixes but does not track `main`. The runtime foundation, its architecture, and the design story are Tom's work at [monotykamary/pi-fabric](https://github.com/monotykamary/pi-fabric); this fork adds the hardening and skill patterns above. If a change here proves generally useful, it's a candidate to send upstream.

## License

MIT, same as upstream. Copyright for the base runtime remains © 2026 monotykamary; see [LICENSE](./LICENSE).
