import ts from "typescript";

// "LID lint" — locally-in-distribution lint for authored fabric_exec programs.
//
// fabric_exec programs perform best when each agent() call sees a small,
// focused prompt ("locally in-distribution") and large content flows through
// variables/files instead of being inlined into prompts. These rules warn on
// two authored-program antipatterns that defeat that property:
//   (a) oversized-inline-prompt — stuffing very large literal content into a
//       single agent prompt.
//   (b) harness-collapse — a program whose single agent call just forwards the
//       whole task, adding no decomposition or orchestration structure.
//
// Every finding is a WARNING: advisory only. The lint never blocks execution
// and never turns into an error.

type FabricLintRule = "oversized-inline-prompt" | "harness-collapse";

export interface FabricTypeWarning {
  line: number;
  column: number;
  message: string;
  rule: FabricLintRule;
}

export interface FabricLintOptions {
  enabled: boolean;
  maxInlinePromptChars: number;
}

const DEFAULT_MAX_INLINE_PROMPT_CHARS = 8000;

export const DEFAULT_LINT_OPTIONS: FabricLintOptions = {
  enabled: true,
  maxInlinePromptChars: DEFAULT_MAX_INLINE_PROMPT_CHARS,
};

// harness-collapse only fires when the single dispatch adds fewer than this
// much static instruction text around the forwarded π.<name> content — i.e.
// the orchestration is not contributing structure of its own.
const HARNESS_COLLAPSE_MAX_STATIC_CHARS = 200;

const OVERSIZED_MESSAGE =
  "large inline prompt content; consider writing content to a file or variable and passing a reference so each call stays small";
const HARNESS_COLLAPSE_MESSAGE =
  "program forwards the task to a single agent without decomposition; consider whether the orchestration adds structure, or call the model directly";

// The strings object is exposed to guest programs as `π` (π.<name>); large or
// awkward content is passed through it instead of being inlined.
const STRINGS_IDENTIFIER = "π";

type DispatchKind = "agent" | "agents.run" | "rlm.query";

// Match the guest agent-dispatch entry points. `agent<T>(...)` keeps `agent`
// as the call expression's identifier (type args live on the CallExpression),
// so an identifier check is sufficient.
const dispatchKind = (call: ts.CallExpression): DispatchKind | undefined => {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && callee.text === "agent") return "agent";
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    ts.isIdentifier(callee.name)
  ) {
    if (callee.expression.text === "agents" && callee.name.text === "run") {
      return "agents.run";
    }
    if (callee.expression.text === "rlm" && callee.name.text === "query") {
      return "rlm.query";
    }
  }
  return undefined;
};

const isParallelOrPipeline = (call: ts.CallExpression): boolean => {
  const callee = call.expression;
  return (
    ts.isIdentifier(callee) &&
    (callee.text === "parallel" || callee.text === "pipeline")
  );
};

const propertyName = (name: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
};

// Locate the prompt argument for a given dispatch call. `agent(prompt, opts)`
// takes the prompt positionally; `agents.run`/`rlm.query` receive an options
// object whose task/prompt/query property carries the prompt. When the prompt
// cannot be isolated conservatively, return undefined (skip — no false alarm).
const PROMPT_KEYS = new Set(["task", "prompt", "query"]);

const promptNode = (
  call: ts.CallExpression,
  kind: DispatchKind,
): ts.Node | undefined => {
  const first = call.arguments[0];
  if (!first) return undefined;
  if (kind === "agent") return first;
  if (ts.isObjectLiteralExpression(first)) {
    for (const prop of first.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = propertyName(prop.name);
      if (key && PROMPT_KEYS.has(key)) return prop.initializer;
    }
    return undefined;
  }
  return first;
};

// Sum the *static* string content reachable from a node: string literals and
// template-literal quasis. Interpolated expressions (the dynamic parts) are
// deliberately not counted — that content flows at runtime, not from the
// authored prompt. String concatenation (`"a" + "b"`) is summed naturally by
// descending into non-template children.
const staticStringChars = (node: ts.Node): number => {
  let total = 0;
  const visit = (current: ts.Node): void => {
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
    ) {
      total += current.text.length;
      return;
    }
    if (ts.isTemplateExpression(current)) {
      total += current.head.text.length;
      for (const span of current.templateSpans) {
        total += span.literal.text.length;
        // Intentionally do not descend into span.expression: interpolated
        // values are dynamic, not authored static prompt text.
      }
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return total;
};

// Whether the node interpolates a strings member (π.<name> or π["<name>"]).
// Unlike staticStringChars this searches the whole subtree, including template
// interpolations, since π.task is usually referenced inside `${...}`.
const referencesStringsMember = (node: ts.Node): boolean => {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (
      (ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === STRINGS_IDENTIFIER
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
};

export const lintFabricProgram = (
  sourceFile: ts.SourceFile,
  options: FabricLintOptions = DEFAULT_LINT_OPTIONS,
): FabricTypeWarning[] => {
  if (!options.enabled) return [];

  const dispatches: { call: ts.CallExpression; kind: DispatchKind }[] = [];
  let usesParallelOrPipeline = false;

  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = dispatchKind(node);
      if (kind) dispatches.push({ call: node, kind });
      else if (isParallelOrPipeline(node)) usesParallelOrPipeline = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);

  // Guest code is type-checked wrapped in `async function __piFabricMain() {\n`
  // (one line before the user's line 1), so the 0-based line index equals the
  // user-facing 1-based line — the same mapping the type error path uses.
  const locate = (node: ts.Node): { line: number; column: number } => {
    const position = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    return { line: Math.max(1, position.line), column: position.character + 1 };
  };

  const warnings: FabricTypeWarning[] = [];

  // RULE oversized-inline-prompt
  for (const { call, kind } of dispatches) {
    const prompt = promptNode(call, kind);
    if (!prompt) continue;
    if (staticStringChars(prompt) > options.maxInlinePromptChars) {
      warnings.push({
        ...locate(prompt),
        message: OVERSIZED_MESSAGE,
        rule: "oversized-inline-prompt",
      });
    }
  }

  // RULE harness-collapse
  if (dispatches.length === 1 && !usesParallelOrPipeline) {
    const only = dispatches[0]!;
    const prompt = promptNode(only.call, only.kind);
    if (
      prompt &&
      referencesStringsMember(prompt) &&
      staticStringChars(prompt) < HARNESS_COLLAPSE_MAX_STATIC_CHARS
    ) {
      warnings.push({
        ...locate(only.call),
        message: HARNESS_COLLAPSE_MESSAGE,
        rule: "harness-collapse",
      });
    }
  }

  return warnings;
};
