import { describe, expect, it } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

const check = (code: string, options?: Parameters<typeof typeCheckFabricCode>[2]) =>
  typeCheckFabricCode(code, GUEST_TYPE_DECLARATIONS, options);

const rules = (code: string, options?: Parameters<typeof typeCheckFabricCode>[2]) =>
  check(code, options).warnings.map((warning) => warning.rule);

describe("LID lint: warnings channel contract", () => {
  it("always returns a warnings array without touching the errors contract", () => {
    const result = check('return "ok";');
    expect(result.errors).toEqual([]);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("keeps warnings advisory even when the program has type errors", () => {
    const result = check("await pi.read({ path: missingFile });\nreturn 1;");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

describe("LID lint: oversized-inline-prompt", () => {
  const big = "x".repeat(8_001);
  const nearLimit = "x".repeat(8_000);

  it("warns when a single agent() prompt exceeds the default threshold", () => {
    const result = check(`return agent("${big}");`);
    expect(result.errors).toEqual([]);
    expect(rules(`return agent("${big}");`)).toContain("oversized-inline-prompt");
  });

  it("does not warn exactly at the threshold (boundary is strictly greater)", () => {
    expect(rules(`return agent("${nearLimit}");`)).not.toContain(
      "oversized-inline-prompt",
    );
  });

  it("sums template quasis and string literals but ignores interpolations", () => {
    // The interpolated variable is huge at runtime, but static quasi text is
    // tiny — no warning, because dynamic content is not authored prompt text.
    const huge = "y".repeat(9_000);
    const code = `const big = "${huge}";\nreturn agent(\`Summarize: \${big}\`);`;
    expect(rules(code)).not.toContain("oversized-inline-prompt");
  });

  it("counts static template quasi text toward the threshold", () => {
    const code = `return agent(\`\${x}${"z".repeat(8_001)}\`);`;
    expect(rules(code)).toContain("oversized-inline-prompt");
  });

  it("measures the task property of agents.run options", () => {
    const code = `return agents.run({ task: "${big}", transport: "process" });`;
    expect(rules(code)).toContain("oversized-inline-prompt");
  });

  it("measures the rlm.query prompt argument", () => {
    const code = `return rlm.query({ task: "${big}" });`;
    expect(rules(code)).toContain("oversized-inline-prompt");
  });

  it("respects a lowered maxInlinePromptChars threshold", () => {
    const code = `return agent("${"a".repeat(50)}");`;
    expect(
      rules(code, { lint: { enabled: true, maxInlinePromptChars: 10 } }),
    ).toContain("oversized-inline-prompt");
  });
});

describe("LID lint: harness-collapse", () => {
  it("warns on a single agent() call that just forwards a π member", () => {
    const code = "return agent(`Do this: ${π.task}`);";
    const result = check(code);
    expect(result.errors).toEqual([]);
    expect(rules(code)).toContain("harness-collapse");
  });

  it("warns when agents.run forwards the strings task with no added structure", () => {
    const code = 'return agents.run({ task: π.task, transport: "process" });';
    expect(rules(code)).toContain("harness-collapse");
  });

  it("does not warn when the single call adds substantial instructions", () => {
    const instruction = "Follow these steps carefully. ".repeat(10); // > 200 chars
    const code = `return agent(\`${instruction}\${π.task}\`);`;
    expect(rules(code)).not.toContain("harness-collapse");
  });

  it("does not warn when there is more than one dispatch call", () => {
    const code = [
      "const a = await agent(`Plan: ${π.task}`);",
      "return agent(`Execute: ${π.task}`);",
    ].join("\n");
    expect(rules(code)).not.toContain("harness-collapse");
  });

  it("does not warn when the program decomposes via parallel()", () => {
    const code = [
      "const parts = await parallel([",
      "  () => agent(`A: ${π.task}`),",
      "]);",
      "return parts;",
    ].join("\n");
    // Only one literal agent-dispatch appears, but parallel() supplies
    // orchestration structure, so harness-collapse must stay silent.
    expect(rules(code)).not.toContain("harness-collapse");
  });

  it("does not warn when the prompt does not reference a π member", () => {
    const code = 'return agent("Summarize the repository state");';
    expect(rules(code)).not.toContain("harness-collapse");
  });
});

describe("LID lint: disabled configuration", () => {
  const collapse = "return agent(`Do this: ${π.task}`);";
  const oversized = `return agent("${"x".repeat(8_001)}");`;

  it("emits nothing when the lint is disabled via options", () => {
    const options = { lint: { enabled: false, maxInlinePromptChars: 8_000 } };
    expect(check(collapse, options).warnings).toEqual([]);
    expect(check(oversized, options).warnings).toEqual([]);
  });
});

describe("LID lint: config normalization", () => {
  it("defaults to enabled with an 8000-char threshold", () => {
    const config = normalizeFabricConfig({});
    expect(config.executor.lint).toEqual({
      enabled: true,
      maxInlinePromptChars: 8_000,
    });
  });

  it("accepts a tuned and disabled lint section", () => {
    const config = normalizeFabricConfig({
      executor: { lint: { enabled: false, maxInlinePromptChars: 500 } },
    });
    expect(config.executor.lint).toEqual({
      enabled: false,
      maxInlinePromptChars: 500,
    });
  });

  it("clamps out-of-range thresholds to the allowed bounds", () => {
    const low = normalizeFabricConfig({
      executor: { lint: { maxInlinePromptChars: 1 } },
    });
    expect(low.executor.lint.maxInlinePromptChars).toBe(100);
  });
});
