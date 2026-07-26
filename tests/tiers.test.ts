import { describe, expect, it } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import {
  assignTiers,
  isModelTier,
  rankModels,
  resolveTier,
  type TierCandidate,
} from "../src/agents/tiers.js";

// All model names below are invented vendor/id pairs. Nothing here references a
// real vendor, model ID, or reasoning level — the ranking must be vendor-neutral.

const key = (candidate: TierCandidate): string => `${candidate.provider}/${candidate.id}`;

describe("isModelTier", () => {
  it("accepts only the three tiers", () => {
    expect(isModelTier("small")).toBe(true);
    expect(isModelTier("medium")).toBe(true);
    expect(isModelTier("big")).toBe(true);
    expect(isModelTier("huge")).toBe(false);
    expect(isModelTier(undefined)).toBe(false);
    expect(isModelTier(1)).toBe(false);
  });
});

describe("rankModels — price-first", () => {
  it("ranks purely by output price, cheapest first, regardless of vendor name", () => {
    const catalog: TierCandidate[] = [
      { provider: "zorp", id: "bar-ultra", outputPrice: 30 },
      { provider: "acme", id: "foo-thing", outputPrice: 1 },
      { provider: "quux", id: "baz-engine", outputPrice: 8 },
    ];
    const ranked = rankModels(catalog).map((model) => model.key);
    expect(ranked).toEqual(["acme/foo-thing", "quux/baz-engine", "zorp/bar-ultra"]);
  });

  it("never inverts a priced pair even when hint bands disagree with price", () => {
    // The pricier model carries a "mini" (low-band) hint; the cheaper one carries
    // a "max" (high-band) hint. Price must still win — no inversion.
    const catalog: TierCandidate[] = [
      { provider: "acme", id: "mini-supreme", outputPrice: 50 },
      { provider: "zorp", id: "max-basic", outputPrice: 2 },
    ];
    const ranked = rankModels(catalog);
    expect(ranked.map((m) => m.key)).toEqual(["zorp/max-basic", "acme/mini-supreme"]);
    // Priced scores are non-decreasing across the ranking.
    const scores = ranked.map((model) => model.score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
  });

  it("keeps every priced pair non-inverted in a large mixed catalog", () => {
    const catalog: TierCandidate[] = [
      { provider: "acme", id: "foo-large", outputPrice: 12 },
      { provider: "zorp", id: "bar-mini", outputPrice: 3 },
      { provider: "quux", id: "novel-name" }, // unpriced, neutral hint
      { provider: "glorp", id: "thing-flash" }, // unpriced, low hint
      { provider: "blar", id: "core-pro", outputPrice: 40 },
    ];
    const ranked = rankModels(catalog);
    const pricedScores = ranked.filter((m) => m.priced).map((m) => m.score);
    const sorted = [...pricedScores].sort((a, b) => a - b);
    expect(pricedScores).toEqual(sorted);
  });
});

describe("rankModels — unpriced projection via hint bands", () => {
  it("projects unpriced models onto the known price range by hint band", () => {
    const catalog: TierCandidate[] = [
      { provider: "acme", id: "anchor-cheap", outputPrice: 2 },
      { provider: "acme", id: "anchor-dear", outputPrice: 20 },
      { provider: "novau", id: "widget-nano" }, // low hint -> near min
      { provider: "novau", id: "widget-ultra" }, // high hint -> near max
      { provider: "novau", id: "widget-plain" }, // neutral -> middle
    ];
    const ranked = rankModels(catalog);
    const scoreOf = (k: string): number =>
      ranked.find((m) => m.key === k)?.score as number;

    // Projected scores stay inside [min, max] of the priced anchors.
    expect(scoreOf("novau/widget-nano")).toBe(2);
    expect(scoreOf("novau/widget-ultra")).toBe(20);
    expect(scoreOf("novau/widget-plain")).toBe(11);
    // low <= neutral <= high after projection.
    expect(scoreOf("novau/widget-nano")).toBeLessThanOrEqual(scoreOf("novau/widget-plain"));
    expect(scoreOf("novau/widget-plain")).toBeLessThanOrEqual(scoreOf("novau/widget-ultra"));
  });

  it("falls back to pure hint-band ordering when nothing is priced", () => {
    const catalog: TierCandidate[] = [
      { provider: "acme", id: "thing-pro" }, // high
      { provider: "acme", id: "thing-lite" }, // low
      { provider: "acme", id: "thing-standard" }, // neutral
    ];
    const ranked = rankModels(catalog).map((m) => m.key);
    expect(ranked).toEqual(["acme/thing-lite", "acme/thing-standard", "acme/thing-pro"]);
  });

  it("treats a name with both a low and a high hint as neutral", () => {
    const catalog: TierCandidate[] = [
      { provider: "acme", id: "cheap-one", outputPrice: 1 },
      { provider: "acme", id: "dear-one", outputPrice: 9 },
      { provider: "acme", id: "flash-pro" }, // low + high hint -> neutral -> middle
    ];
    const ranked = rankModels(catalog);
    expect(ranked.find((m) => m.key === "acme/flash-pro")?.band).toBe("neutral");
    expect(ranked.find((m) => m.key === "acme/flash-pro")?.score).toBe(5);
  });
});

describe("assignTiers — guards", () => {
  it("maps small/medium/big to cheapest/middle/priciest", () => {
    const catalog: TierCandidate[] = [
      { provider: "acme", id: "a", outputPrice: 1 },
      { provider: "acme", id: "b", outputPrice: 5 },
      { provider: "acme", id: "c", outputPrice: 9 },
    ];
    expect(assignTiers(catalog)).toEqual({
      small: "acme/a",
      medium: "acme/b",
      big: "acme/c",
    });
  });

  it("never collapses the three tiers onto one model with >= 3 distinct models", () => {
    for (let n = 3; n <= 12; n += 1) {
      const catalog: TierCandidate[] = Array.from({ length: n }, (_, i) => ({
        provider: "acme",
        id: `m${i}`,
        outputPrice: i + 1,
      }));
      const tiers = assignTiers(catalog);
      const distinct = new Set([tiers.small, tiers.medium, tiers.big]);
      expect(distinct.size).toBe(3);
    }
  });

  it("does not collapse tiers even when >= 3 distinct models share one price", () => {
    const catalog: TierCandidate[] = [
      { provider: "acme", id: "one", outputPrice: 7 },
      { provider: "zorp", id: "two", outputPrice: 7 },
      { provider: "quux", id: "three", outputPrice: 7 },
    ];
    const tiers = assignTiers(catalog);
    const distinct = new Set([tiers.small, tiers.medium, tiers.big]);
    expect(distinct.size).toBe(3);
  });

  it("collapses gracefully for a single-model catalog", () => {
    const catalog: TierCandidate[] = [{ provider: "solo", id: "only", outputPrice: 4 }];
    expect(assignTiers(catalog)).toEqual({
      small: "solo/only",
      medium: "solo/only",
      big: "solo/only",
    });
  });

  it("returns undefined tiers for an empty catalog", () => {
    expect(assignTiers([])).toEqual({ small: undefined, medium: undefined, big: undefined });
  });

  it("deduplicates repeated provider/id entries before ranking", () => {
    const catalog: TierCandidate[] = [
      { provider: "acme", id: "dupe", outputPrice: 3 },
      { provider: "acme", id: "dupe", outputPrice: 3 },
      { provider: "acme", id: "other", outputPrice: 9 },
    ];
    const ranked = rankModels(catalog);
    expect(ranked.map(key => key.key)).toEqual(["acme/dupe", "acme/other"]);
  });
});

describe("resolveTier — override precedence", () => {
  const catalog: TierCandidate[] = [
    { provider: "acme", id: "a", outputPrice: 1 },
    { provider: "acme", id: "b", outputPrice: 5 },
    { provider: "acme", id: "c", outputPrice: 9 },
  ];

  it("uses auto-ranking when no override is present", () => {
    expect(resolveTier("small", catalog)).toBe("acme/a");
    expect(resolveTier("medium", catalog)).toBe("acme/b");
    expect(resolveTier("big", catalog)).toBe("acme/c");
  });

  it("lets an explicit config override win over auto-ranking", () => {
    const overrides = { small: "custom/tiny", big: "custom/whale" };
    expect(resolveTier("small", catalog, overrides)).toBe("custom/tiny");
    // medium has no override, so it still auto-ranks.
    expect(resolveTier("medium", catalog, overrides)).toBe("acme/b");
    expect(resolveTier("big", catalog, overrides)).toBe("custom/whale");
  });

  it("ignores blank override strings and falls back to auto-ranking", () => {
    expect(resolveTier("small", catalog, { small: "   " })).toBe("acme/a");
  });

  it("returns an override even when the catalog is empty", () => {
    expect(resolveTier("big", [], { big: "custom/whale" })).toBe("custom/whale");
    expect(resolveTier("big", [])).toBeUndefined();
  });
});

describe("config — agents.tiers normalization", () => {
  it("keeps only non-blank tier override strings", () => {
    const config = normalizeFabricConfig({
      agents: { tiers: { small: "acme/tiny", medium: "  ", big: "zorp/whale", extra: "ignored" } },
    });
    expect(config.agents.tiers).toEqual({ small: "acme/tiny", big: "zorp/whale" });
  });

  it("omits tiers entirely when none are configured", () => {
    const config = normalizeFabricConfig({ agents: {} });
    expect(config.agents.tiers).toBeUndefined();
  });

  it("drops a tiers object whose values are all blank or non-string", () => {
    const config = normalizeFabricConfig({
      agents: { tiers: { small: "", medium: 3, big: null } },
    });
    expect(config.agents.tiers).toBeUndefined();
  });
});
