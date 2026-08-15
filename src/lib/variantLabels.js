// Deterministic label overrides — not LLM-generated, just a lookup. The
// underlying selection criteria (highest greenery/scenic score, shortest
// distance) never change; only the display name adapts to what the user
// actually emphasized, so the three alternative cards don't always show
// the same generic names regardless of the request.
const GREENEST_LABEL_BY_PREFERENCE = {
  greenery: "Maximum Greenery",
};

const SCENIC_LABEL_BY_PREFERENCE = {
  waterfront: "Most Waterfront",
  landmarks: "Most Historic",
};

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Returns { greenest, scenic, efficient } display labels for the "Other
 * options to consider" cards, adapted to preferenceEmphasis (which scenery
 * type the user emphasized) and stopType (e.g. "coffee", "library", if a
 * stop was requested). "Best Match" (the hero card) is a constant elsewhere
 * and isn't part of this.
 */
export function getVariantLabels(preferenceEmphasis, stopType) {
  return {
    greenest: GREENEST_LABEL_BY_PREFERENCE[preferenceEmphasis] || "Greenest",
    scenic: SCENIC_LABEL_BY_PREFERENCE[preferenceEmphasis] || "Most Scenic",
    efficient: stopType ? `Best ${capitalize(stopType)} Route` : "Most Efficient",
  };
}
