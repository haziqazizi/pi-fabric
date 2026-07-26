import { describe, expect, it } from "vitest";
import { NodeProcessRuntime } from "../src/runtime/node-process-runtime.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";

const options = {
  timeoutMs: 5_000,
  memoryLimitBytes: 32 * 1024 * 1024,
};

type HostCall = (ref: string, args: Record<string, unknown>) => Promise<unknown>;

// Span calls come from parallel()'s workflow span wrapper and carry no meaning
// for these helpers; a test host answers them with undefined and forwards the
// rest to the scenario handler.
const withSpans =
  (handler: HostCall): HostCall =>
  async (ref, args) => {
    if (ref === "fabric.$spanStart" || ref === "fabric.$spanEnd") return undefined;
    return handler(ref, args);
  };

const runQuick = (code: string, handler: HostCall) =>
  new QuickJsRuntime().execute(code, withSpans(handler), options);

describe("quality-pattern guest helpers", () => {
  describe("verify", () => {
    it("omits thrown reviewers from the denominator", async () => {
      const result = await runQuick(
        `return verify("the sky is green", { reviewers: 3 });`,
        async (ref, args) => {
          if (ref !== "agents.run") throw new Error(`unexpected ${ref}`);
          const name = String(args.name ?? "");
          if (name.endsWith("2")) {
            return { status: "failed", error: "provider down", usage: { input: 0, output: 0 } };
          }
          const real = name.endsWith("1");
          return { status: "completed", value: { real }, usage: { input: 1, output: 1 } };
        },
      );
      expect(result.error).toBeUndefined();
      // reviewer 2 threw -> denominator is 2; reviewer 1 votes yes -> 1/2 >= 0.5.
      expect(result.value).toEqual({ real: true, votes: 1, reviewers: 2 });
    });

    it("returns real:false when every reviewer throws", async () => {
      const result = await runQuick(
        `return verify("unfounded claim", { reviewers: 3 });`,
        async (ref) => {
          if (ref !== "agents.run") throw new Error(`unexpected ${ref}`);
          return { status: "failed", error: "provider down", usage: { input: 0, output: 0 } };
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ real: false, votes: 0, reviewers: 0 });
    });

    it("defaults reviewer count to 3 and respects the threshold", async () => {
      const seenModels: unknown[] = [];
      const result = await runQuick(
        `return verify("mixed claim", { threshold: 0.75, model: "acme-model-9", tier: "fast", thinking: "high" });`,
        async (ref, args) => {
          if (ref !== "agents.run") throw new Error(`unexpected ${ref}`);
          seenModels.push({ model: args.model, tier: args.tier, thinking: args.thinking });
          const real = String(args.name ?? "").endsWith("1");
          return { status: "completed", value: { real }, usage: { input: 1, output: 1 } };
        },
      );
      expect(result.error).toBeUndefined();
      // 1 yes of 3 = 0.333 < 0.75 threshold.
      expect(result.value).toEqual({ real: false, votes: 1, reviewers: 3 });
      // Routing options pass straight through to agent() untouched.
      expect(seenModels).toHaveLength(3);
      expect(seenModels[0]).toEqual({ model: "acme-model-9", tier: "fast", thinking: "high" });
    });

    it("distributes lenses round-robin across reviewers", async () => {
      const prompts: string[] = [];
      await runQuick(
        `return verify("claim", { reviewers: 4, lenses: ["security", "performance"] });`,
        async (ref, args) => {
          if (ref !== "agents.run") throw new Error(`unexpected ${ref}`);
          prompts.push(String(args.task ?? ""));
          return { status: "completed", value: { real: true }, usage: { input: 1, output: 1 } };
        },
      );
      expect(prompts).toHaveLength(4);
      expect(prompts[0]).toContain("security");
      expect(prompts[1]).toContain("performance");
      expect(prompts[2]).toContain("security");
      expect(prompts[3]).toContain("performance");
    });
  });

  describe("judgePanel", () => {
    it("breaks ties toward the lowest input index (stable)", async () => {
      const result = await runQuick(
        `return judgePanel(["x", "y", "z"], { rubric: "quality", judges: 3 });`,
        async (ref) => {
          if (ref !== "agents.run") throw new Error(`unexpected ${ref}`);
          return { status: "completed", value: { scores: [0.6, 0.6, 0.6] }, usage: { input: 1, output: 1 } };
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ index: 0, mean: 0.6, scores: [0.6, 0.6, 0.6] });
    });

    it("picks the highest mean and clamps out-of-range scores", async () => {
      const result = await runQuick(
        `return judgePanel(["a", "b"], { rubric: "quality", judges: 1 });`,
        async (ref) => {
          if (ref !== "agents.run") throw new Error(`unexpected ${ref}`);
          // 2 -> clamps to 1, -1 -> clamps to 0.
          return { status: "completed", value: { scores: [2, -1] }, usage: { input: 1, output: 1 } };
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ index: 0, mean: 1, scores: [1, 0] });
    });

    it("rejects when no rubric is provided", async () => {
      const result = await runQuick(
        `return judgePanel(["a"], {});`,
        async () => undefined,
      );
      expect(result.terminationReason).toBe("runtime_error");
      expect(result.error).toContain("rubric");
    });
  });

  describe("loopUntilDry", () => {
    it("does not count a thrown round toward the dry streak", async () => {
      const result = await runQuick(
        `
const scripted = [
  () => ["a"],
  () => { throw new Error("round failed"); },
  () => [],
  () => [],
];
let i = 0;
return loopUntilDry({
  round: async () => scripted[i++](),
  key: (t) => t,
  consecutiveEmpty: 2,
  maxRounds: 8,
});
`,
        async () => undefined,
      );
      expect(result.error).toBeUndefined();
      // The throw at round 1 must not contribute to the empty streak, so the two
      // real empties (rounds 2 and 3) are what makes it dry after 4 attempts.
      expect(result.value).toEqual({ items: ["a"], rounds: 4, dry: true });
    });

    it("dedups against all previously seen keys", async () => {
      const result = await runQuick(
        `
const scripted = [
  () => ["a", "b"],
  () => ["b", "c"],
  () => [],
  () => [],
];
let i = 0;
return loopUntilDry({
  round: async () => scripted[i++](),
  key: (t) => t,
  consecutiveEmpty: 2,
  maxRounds: 8,
});
`,
        async () => undefined,
      );
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ items: ["a", "b", "c"], rounds: 4, dry: true });
    });

    it("returns dry:false at maxRounds without ever throwing", async () => {
      const result = await runQuick(
        `
return loopUntilDry({
  round: async () => { throw new Error("always fails"); },
  key: (t) => t,
  consecutiveEmpty: 2,
  maxRounds: 3,
});
`,
        async () => undefined,
      );
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ items: [], rounds: 3, dry: false });
    });
  });

  describe("gate", () => {
    it("threads validator feedback into the next make call and succeeds", async () => {
      const result = await runQuick(
        `
return gate(
  async (feedback, i) => (i === 0 ? "cand0" : "cand" + i + ":" + feedback),
  async (value, i) => (i < 2 ? { ok: false, feedback: "need more " + i } : { ok: true }),
  { attempts: 3 },
);
`,
        async () => undefined,
      );
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ ok: true, value: "cand2:need more 1", attempts: 3 });
    });

    it("returns visible failure on exhaustion without masquerading as success", async () => {
      const result = await runQuick(
        `return gate(async () => "x", async () => ({ ok: false, feedback: "nope" }), { attempts: 2 });`,
        async () => undefined,
      );
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ ok: false, value: "x", attempts: 2, feedback: "nope" });
    });

    it("never throws when make throws every attempt", async () => {
      const result = await runQuick(
        `return gate(async () => { throw new Error("make boom"); }, async () => ({ ok: true }), { attempts: 2 });`,
        async () => undefined,
      );
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ ok: false, value: null, attempts: 2, feedback: "make boom" });
    });

    it("never throws when validate throws and keeps the last candidate", async () => {
      const result = await runQuick(
        `return gate(async () => "c", async () => { throw new Error("val boom"); }, { attempts: 2 });`,
        async () => undefined,
      );
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ ok: false, value: "c", attempts: 2, feedback: "val boom" });
    });
  });

  it("exposes the helpers on the node-process executor too", async () => {
    const result = await new NodeProcessRuntime().execute(
      `return { helpers: [typeof verify, typeof judgePanel, typeof loopUntilDry, typeof gate] };`,
      async () => undefined,
      { ...options, memoryLimitBytes: 128 * 1024 * 1024 },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ helpers: ["function", "function", "function", "function"] });
  });
});
