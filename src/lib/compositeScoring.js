const WEIGHTS_BY_PREFERENCE = {
  greenery: { trees: 0.7, landmarks: 0.15, waterfront: 0.15 },
  landmarks: { trees: 0.15, landmarks: 0.7, waterfront: 0.15 },
  waterfront: { trees: 0.15, landmarks: 0.15, waterfront: 0.7 },
  balanced: { trees: 1 / 3, landmarks: 1 / 3, waterfront: 1 / 3 },
};

/**
 * Min-max normalizes a batch of values to 0-1, relative to this batch only.
 * If every value is tied, all get 1 (tied-and-present) or 0 (tied-at-zero) —
 * either way the tie contributes the same constant to every candidate, so it
 * never affects which candidate wins; it just keeps the displayed score sane.
 */
function normalize(values) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;
  return values.map((v) => (range > 0 ? (v - min) / range : max > 0 ? 1 : 0));
}

/**
 * Ranks already-scored candidates (each with treeScore.treeCount and
 * scenicScore.{landmarkCount,waterfrontCount} from the existing scoring
 * pipeline) by a single composite score: normalize each metric 0-1 across
 * this batch, weight by preference_emphasis, sum. Falls back to "balanced"
 * weights for an unrecognized preference.
 */
export function rankByComposite(scoredCandidates, preferenceEmphasis) {
  const weights = WEIGHTS_BY_PREFERENCE[preferenceEmphasis] || WEIGHTS_BY_PREFERENCE.balanced;

  const treesNorm = normalize(scoredCandidates.map((c) => c.treeScore.treeCount));
  const landmarksNorm = normalize(scoredCandidates.map((c) => c.scenicScore.landmarkCount));
  const waterfrontNorm = normalize(scoredCandidates.map((c) => c.scenicScore.waterfrontCount));

  const ranked = scoredCandidates
    .map((c, i) => {
      const normalized = { trees: treesNorm[i], landmarks: landmarksNorm[i], waterfront: waterfrontNorm[i] };
      const compositeScore =
        normalized.trees * weights.trees +
        normalized.landmarks * weights.landmarks +
        normalized.waterfront * weights.waterfront;
      return { ...c, normalized, compositeScore };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);

  return { ranked, winner: ranked[0], weights, preferenceEmphasis: preferenceEmphasis || "balanced" };
}
