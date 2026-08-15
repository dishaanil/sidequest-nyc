// Fixed share of the composite score reserved for hitting the requested
// distance, regardless of preference — a beautiful route that's way off
// target shouldn't be able to outscore an accurate one.
const DISTANCE_WEIGHT = 0.3;
// Deviation fraction (|actual-target|/target) at which distance-accuracy
// bottoms out at 0. 10% deviation (the max tolerance) still scores 0.75.
const DISTANCE_SATURATION = 0.4;

const SCENERY_WEIGHTS_BY_PREFERENCE = {
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

/** 1.0 at the exact target distance, decaying to 0 by DISTANCE_SATURATION deviation. Absolute, not batch-relative — being off-target is a real penalty even if every candidate is off-target. */
function distanceAccuracy(distanceMeters, targetDistanceMeters) {
  const deviation = Math.abs(distanceMeters - targetDistanceMeters) / targetDistanceMeters;
  return Math.max(0, 1 - deviation / DISTANCE_SATURATION);
}

/**
 * Ranks already-scored candidates (each with treeScore.treeCount,
 * scenicScore.{landmarkCount,waterfrontCount}, and route.distanceMeters)
 * by a single composite score: normalize each scenery metric 0-1 across
 * this batch, weight by preference_emphasis, and add an absolute
 * distance-accuracy term (fixed weight, not batch-relative) so distance
 * deviation is a real penalty. Falls back to "balanced" weights for an
 * unrecognized preference.
 */
export function rankByComposite(scoredCandidates, preferenceEmphasis, targetDistanceMeters) {
  const sceneryWeights = SCENERY_WEIGHTS_BY_PREFERENCE[preferenceEmphasis] || SCENERY_WEIGHTS_BY_PREFERENCE.balanced;
  const sceneryBudget = 1 - DISTANCE_WEIGHT;
  const weights = {
    trees: sceneryWeights.trees * sceneryBudget,
    landmarks: sceneryWeights.landmarks * sceneryBudget,
    waterfront: sceneryWeights.waterfront * sceneryBudget,
    distance: DISTANCE_WEIGHT,
  };

  const treesNorm = normalize(scoredCandidates.map((c) => c.treeScore.treeCount));
  const landmarksNorm = normalize(scoredCandidates.map((c) => c.scenicScore.landmarkCount));
  const waterfrontNorm = normalize(scoredCandidates.map((c) => c.scenicScore.waterfrontCount));

  const ranked = scoredCandidates
    .map((c, i) => {
      const normalized = {
        trees: treesNorm[i],
        landmarks: landmarksNorm[i],
        waterfront: waterfrontNorm[i],
        distance: distanceAccuracy(c.route.distanceMeters, targetDistanceMeters),
      };
      const compositeScore =
        normalized.trees * weights.trees +
        normalized.landmarks * weights.landmarks +
        normalized.waterfront * weights.waterfront +
        normalized.distance * weights.distance;
      return { ...c, normalized, compositeScore };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);

  return { ranked, winner: ranked[0], weights, preferenceEmphasis: preferenceEmphasis || "balanced" };
}
