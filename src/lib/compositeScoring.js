// Deviation fraction (|actual-target|/target) at which raw distance
// accuracy bottoms out at 0. 10% deviation (the max tolerance) still scores
// 0.75 before flooring.
const DISTANCE_SATURATION = 0.4;

// Multiplicative floors. Composite = sceneryScore * distanceFactor, and a
// hard 0 on either side of a multiplication zeroes the whole product — which
// is correct for "way off target" but wrong for "happened to have the
// lowest tree count in this particular batch." Both factors get a small
// floor instead of touching literal 0, and the floors are deliberately
// asymmetric: distance's is much smaller than scenery's, so severe distance
// error still dominates ordinary scenery-ranking noise rather than the two
// floors coincidentally cancelling out.
const SCENERY_FLOOR = 0.15;
const DISTANCE_FLOOR = 0.05;

const SCENERY_WEIGHTS_BY_PREFERENCE = {
  greenery: { trees: 0.7, landmarks: 0.15, waterfront: 0.15 },
  landmarks: { trees: 0.15, landmarks: 0.7, waterfront: 0.15 },
  waterfront: { trees: 0.15, landmarks: 0.15, waterfront: 0.7 },
  balanced: { trees: 1 / 3, landmarks: 1 / 3, waterfront: 1 / 3 },
};

/**
 * Min-max normalizes a batch of values to SCENERY_FLOOR..1, relative to
 * this batch only. Floored rather than a literal 0-1 range: composite
 * scoring multiplies this by a distance factor, and a hard 0 here would
 * permanently zero out a candidate just for being the batch's worst on one
 * metric, regardless of how accurate its distance is.
 */
function normalize(values, floor = SCENERY_FLOOR) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;
  if (range === 0) return values.map(() => (max > 0 ? 1 : floor));
  return values.map((v) => floor + (1 - floor) * ((v - min) / range));
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
 * a single composite score: normalize each scenery metric batch-relative
 * (floored, see above) into one 0-1 scenery score per preference_emphasis,
 * then MULTIPLY by a distance-accuracy factor — so a candidate whose
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
    weights: { ...weights, sceneryFloor: SCENERY_FLOOR, distanceFloor: DISTANCE_FLOOR },
    preferenceEmphasis: preferenceEmphasis || "balanced",
  };
}
