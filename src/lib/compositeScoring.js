// Deviation fraction (|actual-target|/target) at which raw distance
// accuracy bottoms out at 0. 10% deviation (the max tolerance) still scores
// 0.75 before flooring.
const DISTANCE_SATURATION = 0.4;
// Minimum distance multiplier even at total distance mismatch. Not a literal
// 0: if every candidate in a batch is equally off-target (the tolerance
// widened to "none" fallback), a hard floor of 0 would tie every composite
// score at exactly 0 and make the "winner" an arbitrary sort artifact.
// 0.1 keeps scenery meaningful as a tiebreaker in that degenerate case while
// still making distance the dominant factor everywhere else.
const DISTANCE_FLOOR = 0.1;

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

/** Maps 0-1 distance accuracy to a DISTANCE_FLOOR..1.0 multiplier. */
function distanceFactor(accuracy) {
  return DISTANCE_FLOOR + (1 - DISTANCE_FLOOR) * accuracy;
}

/**
 * Ranks already-scored candidates (each with treeScore.treeCount,
 * scenicScore.{landmarkCount,waterfrontCount}, and route.distanceMeters) by
 * a single composite score: normalize each scenery metric 0-1 across this
 * batch, weight by preference_emphasis into one 0-1 scenery score, then
 * MULTIPLY by a distance-accuracy factor (not add) — so a candidate whose
 * distance is way off the target has its whole score dragged down
 * regardless of how good its scenery is, instead of just losing a fixed
 * slice of an additive budget. Falls back to "balanced" weights for an
 * unrecognized preference.
 */
export function rankByComposite(scoredCandidates, preferenceEmphasis, targetDistanceMeters) {
  const weights = SCENERY_WEIGHTS_BY_PREFERENCE[preferenceEmphasis] || SCENERY_WEIGHTS_BY_PREFERENCE.balanced;

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
      const sceneryScore =
        normalized.trees * weights.trees + normalized.landmarks * weights.landmarks + normalized.waterfront * weights.waterfront;
      const compositeScore = sceneryScore * distanceFactor(normalized.distance);
      return { ...c, normalized, sceneryScore, compositeScore };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);

  return {
    ranked,
    winner: ranked[0],
    weights: { ...weights, distanceFloor: DISTANCE_FLOOR },
    preferenceEmphasis: preferenceEmphasis || "balanced",
  };
}
