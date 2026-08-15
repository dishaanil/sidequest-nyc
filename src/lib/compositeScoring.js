// Minimum distance multiplier even at total distance mismatch. Not a literal
// 0: if every candidate in a batch is equally off-target (the tolerance
// widened to "none" fallback), a hard floor of 0 would tie every composite
// score at exactly 0 and make the "winner" an arbitrary sort artifact.
const DISTANCE_FLOOR = 0.05;

// Which score.computeScoreBreakdown() field represents "scenery" for a given
// preference_emphasis. Unlike the old count-based version, these are all
// absolute 0-100 exposure scores (not batch-relative), so no normalization
// or flooring is needed on the scenery side anymore — a real 0% exposure is
// a legitimate, defensible zero, not a normalization artifact.
function preferenceSceneryScore(breakdown, preferenceEmphasis) {
  switch (preferenceEmphasis) {
    case "greenery":
      return breakdown.greeneryScore;
    case "landmarks":
      return breakdown.components.landmarkScore;
    case "waterfront":
      return breakdown.components.waterfrontScore;
    default:
      return breakdown.scenicScore; // "balanced" — the blended formula is already a reasonable overall signal
  }
}

/** Maps 0-1 distance accuracy (runningQualityScore/100) to a DISTANCE_FLOOR..1.0 multiplier. */
function distanceFactor(runningQualityScore) {
  const accuracy = runningQualityScore / 100;
  return DISTANCE_FLOOR + (1 - DISTANCE_FLOOR) * accuracy;
}

/**
 * Ranks candidates (each carrying a `breakdown` from computeScoreBreakdown)
 * by a single composite score: pick the scenery score relevant to
 * preference_emphasis, then MULTIPLY by a distance-accuracy factor — so a
 * candidate whose distance is way off the target has its whole score
 * dragged down regardless of how good its scenery is, instead of losing
 * only a fixed slice of an additive budget. Falls back to the blended
 * scenic score for an unrecognized preference.
 */
export function rankByComposite(scoredCandidates, preferenceEmphasis) {
  const ranked = scoredCandidates
    .map((c) => {
      const sceneryScore = preferenceSceneryScore(c.breakdown, preferenceEmphasis);
      const compositeScore = sceneryScore * distanceFactor(c.breakdown.runningQualityScore);
      return { ...c, sceneryScore, compositeScore };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);

  return {
    ranked,
    winner: ranked[0],
    distanceFloor: DISTANCE_FLOOR,
    preferenceEmphasis: preferenceEmphasis || "balanced",
  };
}
