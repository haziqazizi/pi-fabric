#!/usr/bin/env node

import readline from "node:readline";

const send = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const usage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 };

const successMessage = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "fake",
  model: "fake-model",
  usage,
  stopReason: "stop",
});

const providerFailure = () => ({
  role: "assistant",
  content: [],
  provider: "openai-codex",
  model: "gpt-test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  stopReason: "error",
  errorMessage: "fetch failed",
  diagnostics: [
    {
      type: "provider_transport_failure",
      error: { name: "Error", message: "WebSocket error" },
      details: { configuredTransport: "auto", fallbackTransport: "sse" },
    },
  ],
});

const finishAttempt = (message, willRetry) => {
  send({ type: "message_end", message });
  send({ type: "turn_end", message, toolResults: [] });
  send({ type: "agent_end", messages: [message], willRetry });
  send({ type: "agent_settled" });
};

let started = false;
// Schema-repair scenarios keep reading follow_up frames the worker sends when a
// schema run settles without schema-valid output. `schemaMode` selects how each
// re-prompt turn responds; `followUpCount` counts the repair turns received.
let schemaMode = null;
let followUpCount = 0;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  if (started) {
    // Only schema-repair scenarios react to later frames; everything else (the
    // existing one-shot behaviors) ignores post-prompt input as before.
    if (command.type !== "follow_up") return;
    followUpCount += 1;
    send({ type: "agent_start" });
    if (schemaMode === "recover") {
      // The model finally complies on the first repair turn.
      schemaMode = null;
      finishAttempt(successMessage(JSON.stringify({ answer: 42 })), false);
    } else if (schemaMode === "noncompliance") {
      // The model never emits JSON, no matter how many times it is re-prompted.
      finishAttempt(successMessage(`Still no JSON here, attempt ${followUpCount}.`), false);
    }
    return;
  }

  started = true;
  const task = typeof command.message === "string" ? command.message : "";

  send({ type: "response", command: "prompt", success: true });
  send({ type: "agent_start" });

  if (task.includes("RETRY_THEN_SUCCEED")) {
    finishAttempt(providerFailure(), true);
    setTimeout(() => {
      send({ type: "agent_start" });
      finishAttempt(successMessage("retry recovered"), false);
    }, 25);
    return;
  }

  if (task.includes("FAIL_PROVIDER")) {
    finishAttempt(providerFailure(), false);
    return;
  }

  if (task.includes("SCHEMA_REPAIR_RECOVER")) {
    // First turn is prose (no JSON); the worker must re-prompt the same session.
    schemaMode = "recover";
    finishAttempt(successMessage("I am thinking about your request."), false);
    return;
  }

  if (task.includes("SCHEMA_NONCOMPLIANCE")) {
    // Never emits JSON on any turn; bounded repair then host extraction both fail.
    schemaMode = "noncompliance";
    finishAttempt(successMessage("Here is a prose answer with no JSON at all."), false);
    return;
  }

  if (task.includes("SCHEMA_EXTRACT_WARN")) {
    // Emits schema-valid JSON, but wrapped in prose so it is not clean output:
    // the host-side extraction fallback should recover it and flag a warning.
    finishAttempt(
      successMessage('Sure, here you go: {"answer": 7} — hope that helps!'),
      false,
    );
    return;
  }

  if (task.includes("REPORT_FABRIC_IDENTITY")) {
    finishAttempt(
      successMessage(
        JSON.stringify({
          mainAgentId: process.env.PI_FABRIC_MAIN_AGENT_ID,
          parentRun: process.env.PI_FABRIC_PARENT_RUN,
          agentName: process.env.PI_FABRIC_AGENT_NAME,
        }),
      ),
      false,
    );
    return;
  }

  const value = {
    action: "message",
    message: `validated actor response:${process.env.PI_FABRIC_FULL_CODE_MODE ?? "missing"}`,
  };
  finishAttempt(successMessage(JSON.stringify(value)), false);
});

process.stdin.on("end", () => {
  setTimeout(() => process.exit(0), 5);
});
process.stdin.resume();
