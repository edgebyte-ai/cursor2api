import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "../src/config.js";
import {
  normalizedModelFamilies,
  parseModelVariant,
  resolveModel,
  toModelList,
} from "../src/models.js";
import { reasoningEffortOf } from "../src/openai/translate.js";

const ids = [
  "cursor-grok-4.6-low",
  "cursor-grok-4.6-medium",
  "cursor-grok-4.6-high",
  "cursor-grok-4.6-xhigh",
  "cursor-grok-4.6-high-fast",
  "claude-4.6-opus-high",
  "claude-4.6-opus-high-thinking",
  "claude-opus-5-thinking-low",
  "claude-opus-5-thinking-high",
  "composer-2.5",
  "composer-2.5-fast",
];

const modelConfig = (
  modelMode: Config["modelMode"],
  defaultReasoningEffort = "high",
): Pick<Config, "modelPrefix" | "modelMode" | "defaultReasoningEffort"> => ({
  modelPrefix: "cursor-",
  modelMode,
  defaultReasoningEffort,
});

test("normalizes effort while preserving thinking and fast dimensions", () => {
  assert.deepEqual(parseModelVariant("claude-4.6-opus-high-thinking"), {
    familyId: "claude-4.6-opus-thinking",
    effort: "high",
  });
  assert.deepEqual(parseModelVariant("claude-opus-5-thinking-low"), {
    familyId: "claude-opus-5-thinking",
    effort: "low",
  });
  assert.deepEqual(parseModelVariant("cursor-grok-4.6-high-fast"), {
    familyId: "cursor-grok-4.6-fast",
    effort: "high",
  });
  assert.deepEqual(parseModelVariant("composer-2.5-fast"), {
    familyId: "composer-2.5-fast",
  });
});

test("builds normalized families with explicit supported and default efforts", () => {
  const families = normalizedModelFamilies(ids, "high");
  const grok = families.get("cursor-grok-4.6");
  assert.ok(grok);
  assert.deepEqual([...grok.variants.keys()], ["low", "medium", "high", "xhigh"]);
  assert.equal(grok.defaultEffort, "high");
  assert.equal(families.get("composer-2.5")?.fixedUpstreamId, "composer-2.5");
});

test("normalized catalogue removes effort names and advertises actual levels", () => {
  const models = toModelList(ids, "cursor-", "normalized", "high");
  const grok = models.find((model) => model.id === "cursor-grok-4.6");
  assert.ok(grok);
  assert.deepEqual(grok.reasoning_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(grok.default_reasoning_effort, "high");
  assert.ok(models.some((model) => model.id === "cursor-claude-4.6-opus-thinking"));
  assert.ok(models.some((model) => model.id === "cursor-composer-2.5"));
  assert.ok(!models.some((model) => model.id === "cursor-grok-4.6-high"));
});

test("resolves normalized effort families to the exact upstream Cursor ID", () => {
  assert.deepEqual(resolveModel("cursor-grok-4.6", modelConfig("normalized"), ids, "medium"), {
    upstreamId: "cursor-grok-4.6-medium",
    familyId: "cursor-grok-4.6",
    effort: "medium",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
  });
  assert.equal(
    resolveModel("cursor-claude-4.6-opus-thinking", modelConfig("normalized"), ids, "high")
      .upstreamId,
    "claude-4.6-opus-high-thinking",
  );
});

test("rejects unsupported efforts instead of silently changing them", () => {
  const result = resolveModel("cursor-grok-4.6", modelConfig("normalized"), ids, "max");
  assert.equal(result.error, "unsupported_reasoning_effort");
  assert.deepEqual(result.supportedEfforts, ["low", "medium", "high", "xhigh"]);
});

test("fixed models ignore effort and both mode preserves raw IDs", () => {
  assert.equal(
    resolveModel("cursor-composer-2.5", modelConfig("normalized"), ids, "xhigh").upstreamId,
    "composer-2.5",
  );
  assert.equal(
    resolveModel("cursor-grok-4.6-high", modelConfig("both"), ids, "low").upstreamId,
    "cursor-grok-4.6-high",
  );
});

test("reads Chat Completions and Responses-translated effort shapes", () => {
  assert.equal(reasoningEffortOf({ reasoning_effort: " HIGH " }), "high");
  assert.equal(reasoningEffortOf({ reasoning: { effort: "xhigh" } }), "xhigh");
  assert.equal(reasoningEffortOf({}), undefined);
});
