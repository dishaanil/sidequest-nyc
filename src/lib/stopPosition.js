import { destinationPoint, haversineDistance, bearingBetween } from "./geo";

// Where a sidequest stop should ideally sit along the route, as a fraction
// (0-1) of total distance, when the user doesn't say otherwise: coffee is a
// mid-run pick-me-up (~50%), takeout is grabbed near the end so it isn't
// carried far (~85-95%), a package drop-off happens early so it isn't
// carried at all (~5-25%). Only coffee/library have a real POI dataset
// wired up today (see stopFinder.js); takeout/package are listed here so
// the position logic is already correct whenever those get a dataset.
export const STOP_TYPE_DEFAULT_POSITION = {
  coffee: "middle",
  library: "middle",
  takeout: "late",
  package: "early",
};

const POSITION_FRACTION = { early: 0.15, middle: 0.5, late: 0.9 };

/**
 * Resolves the target fraction (0-1) of the route a stop should sit at,
 * honoring an explicit position hint parsed from the user's phrasing (e.g.
 * "before I get home" -> late) over the stop type's own default.
 */
export function resolveStopPositionFraction(stopType, positionHint) {
  if (positionHint && POSITION_FRACTION[positionHint] != null) {
    return { category: positionHint, fraction: POSITION_FRACTION[positionHint], source: "explicit" };
  }
  const category = STOP_TYPE_DEFAULT_POSITION[stopType] || "middle";
  return { category, fraction: POSITION_FRACTION[category], source: "default" };
}

/**
 * Geographic point to search for a stop candidate around, approximating
 * where `fraction` of the way through the route will actually fall. Actual
 * candidate routes don't exist yet at this point in the pipeline, so this
 * is a proxy, not an exact position:
 *  - point-to-point (`end` given): interpolated along the straight line
 *    from start to end, a reasonable stand-in for "fraction of the way
 *    there."
 *  - loop (`end` null): the loop's actual shape isn't chosen until
 *    candidate generation, so this models it as a symmetric out-and-back --
 *    straight-line distance from start peaks at fraction=0.5 (the route's
 *    farthest point) and returns toward start at fraction=0 or 1, along a
 *    fixed reference bearing (due north) since no real direction has been
 *    picked yet.
 */
export function computeIdealStopPoint(start, end, targetDistanceMeters, fraction) {
  if (end) {
    const direct = haversineDistance(start.lat, start.lng, end.lat, end.lng);
    const bearing = bearingBetween(start.lat, start.lng, end.lat, end.lng);
    return destinationPoint(start.lat, start.lng, bearing, fraction * direct);
  }
  const crowFliesFromStart = targetDistanceMeters * Math.min(fraction, 1 - fraction);
  return destinationPoint(start.lat, start.lng, 0, crowFliesFromStart);
}
