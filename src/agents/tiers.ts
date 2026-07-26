// Vendor-neutral small/medium/big model tiers with price-first ranking.
//
// A request can ask for a capability tier ("small" | "medium" | "big") instead
// of naming a concrete model. Fabric resolves the tier against whatever models
// the user actually has configured — any vendors, any names.
//
// Ranking is deliberately model-agnostic:
//   PRIMARY  — output price per token, when the catalog exposes it. Price is
//              robust to novel vendor names and reasoning levels.
//   FALLBACK — generic name-substring hints applied vendor-neutrally. These are
//              capability *bands*, never a hardcoded list of vendor model IDs.
//              Unpriced models are projected onto the known price range through
//              their hint band so they interleave sensibly with priced models.
//
// GUARDS:
//   * With >= 3 distinct models the three tiers never collapse onto one model.
//   * A cheaper (priced) model is never ranked above a pricier one — no
//     inversion. Sorting by real output price guarantees this among priced
//     models; projected scores for unpriced models stay inside [min, max].

export type ModelTier = "small" | "medium" | "big";

export const MODEL_TIERS: readonly ModelTier[] = ["small", "medium", "big"];

export const isModelTier = (value: unknown): value is ModelTier =>
  value === "small" || value === "medium" || value === "big";

/** A single candidate drawn from the available model catalog. */
export interface TierCandidate {
  provider: string;
  id: string;
  /** Output price per token, when the catalog exposes pricing. */
  outputPrice?: number;
}

/** Explicit user mapping from config (`agents.tiers`). Wins over auto-ranking. */
export interface TierOverrides {
  small?: string;
  medium?: string;
  big?: string;
}

type HintBand = "low" | "neutral" | "high";

export interface RankedModel {
  /** `${provider}/${id}` — the key used everywhere a model is named. */
  key: string;
  provider: string;
  id: string;
  outputPrice?: number;
  /** Ordering score: real output price, or a projected/hint score. */
  score: number;
  band: HintBand;
  /** True when the score came from a real output price. */
  priced: boolean;
}

// Vendor-neutral capability hints. These are substrings, NOT vendor model IDs.
// "mini/lite/nano/flash/air/small/tiny/micro" read as low-capability; the
// "pro/max/ultra/large/plus/xl/huge" family reads as high-capability. Any
// vendor that adopts a novel naming scheme simply falls through to neutral and
// is ranked by price alone.
const LOW_HINTS = ["mini", "lite", "nano", "flash", "air", "small", "tiny", "micro"] as const;
const HIGH_HINTS = ["pro", "max", "ultra", "large", "plus", "xl", "huge"] as const;

const BAND_RANK: Record<HintBand, number> = { low: 0, neutral: 1, high: 2 };

const modelKey = (provider: string, id: string): string => `${provider}/${id}`;

const hintBand = (key: string): HintBand => {
  const haystack = key.toLowerCase();
  const low = LOW_HINTS.some((hint) => haystack.includes(hint));
  const high = HIGH_HINTS.some((hint) => haystack.includes(hint));
  if (low && !high) return "low";
  if (high && !low) return "high";
  return "neutral";
};

const isFinitePrice = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const dedupe = (candidates: readonly TierCandidate[]): TierCandidate[] => {
  const seen = new Set<string>();
  const unique: TierCandidate[] = [];
  for (const candidate of candidates) {
    if (
      !candidate ||
      typeof candidate.provider !== "string" ||
      typeof candidate.id !== "string" ||
      !candidate.provider ||
      !candidate.id
    ) {
      continue;
    }
    const key = modelKey(candidate.provider, candidate.id);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
};

/**
 * Rank the catalog least -> most capable. Priced models sort by real output
 * price; unpriced models are projected onto the priced range via their hint
 * band (or ranked purely by band when nothing is priced).
 */
export const rankModels = (candidates: readonly TierCandidate[]): RankedModel[] => {
  const unique = dedupe(candidates);
  const prices = unique
    .map((candidate) => candidate.outputPrice)
    .filter(isFinitePrice);
  const minPrice = prices.length ? Math.min(...prices) : undefined;
  const maxPrice = prices.length ? Math.max(...prices) : undefined;

  const ranked: RankedModel[] = unique.map((candidate) => {
    const key = modelKey(candidate.provider, candidate.id);
    const band = hintBand(key);
    const priced = isFinitePrice(candidate.outputPrice);
    let score: number;
    if (priced) {
      score = candidate.outputPrice as number;
    } else if (minPrice !== undefined && maxPrice !== undefined) {
      // Project the unpriced model onto the known price range via its band so
      // it stays inside [min, max] and never inverts a genuinely-priced pair.
      score =
        band === "low"
          ? minPrice
          : band === "high"
            ? maxPrice
            : (minPrice + maxPrice) / 2;
    } else {
      // No priced anchor anywhere — order purely by capability band.
      score = BAND_RANK[band];
    }
    return {
      key,
      provider: candidate.provider,
      id: candidate.id,
      ...(priced ? { outputPrice: candidate.outputPrice } : {}),
      score,
      band,
      priced,
    };
  });

  return ranked.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (BAND_RANK[a.band] !== BAND_RANK[b.band]) return BAND_RANK[a.band] - BAND_RANK[b.band];
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
};

/**
 * Map each tier onto a concrete model key from the ranked catalog. With >= 3
 * distinct models the chosen indices (0, floor(n/2), n-1) are guaranteed
 * distinct, so the tiers never collapse onto a single model.
 */
export const assignTiers = (
  candidates: readonly TierCandidate[],
): Record<ModelTier, string | undefined> => {
  const ranked = rankModels(candidates);
  const n = ranked.length;
  if (n === 0) return { small: undefined, medium: undefined, big: undefined };
  const small = ranked[0];
  const big = ranked[n - 1];
  // floor(n/2) is never 0 for n >= 2 and never n-1 for n >= 3, so with three or
  // more distinct models small/medium/big land on three distinct entries.
  const medium = ranked[Math.floor(n / 2)];
  return {
    small: small?.key,
    medium: medium?.key,
    big: big?.key,
  };
};

/**
 * Resolve a tier to a concrete model key. An explicit config override always
 * wins over auto-ranking; otherwise the ranked catalog decides. Returns
 * undefined when the catalog is empty and no override applies (caller falls
 * back to its current default model).
 */
export const resolveTier = (
  tier: ModelTier,
  candidates: readonly TierCandidate[],
  overrides?: TierOverrides,
): string | undefined => {
  const override = overrides?.[tier];
  if (typeof override === "string" && override.trim()) return override.trim();
  return assignTiers(candidates)[tier];
};
