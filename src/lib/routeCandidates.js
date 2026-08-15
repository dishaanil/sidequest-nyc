import { destinationPoint, haversineDistance, pointToRouteDistanceMeters, sampleAlongRoute } from "./geo";
import { getWalkingRoute } from "./mapboxApi";
import { getDirectionalBias } from "./directionalBias";
import { mapWithConcurrency } from "./concurrency";

const EVEN_BEARINGS = [20, 65, 110, 155, 200, 245, 290, 335]; // 8-way compass spread, "balanced" coverage
const MAX_CANDIDATES = 8; // NYC Open Data's public endpoint throttles hard under bursty load; 8 keeps scoring volume sane
const ROUTE_FETCH_CONCURRENCY = 4; // cap parallel Mapbox Directions calls
const BEARING_MERGE_DEGREES = 10; // treat bearings this close together as redundant

const TOLERANCE_PREFERRED = 0.05;
const TOLERANCE_MAX = 0.1;

// A real street-grid walking route rarely exceeds ~1.4x the straight-line
// distance of its waypoint chain, even on a diagonal path through Manhattan's
// grid. A ratio beyond this is a strong signal the route was forced around an
// obstacle it can't actually cross on foot (a river with no nearby bridge, a
// highway, etc.) rather than following a plausible path -- e.g. a
// waterfront-biased bearing that projects a waypoint across the Hudson into
// NJ, which Mapbox will still "solve" by routing miles out of the way to the
// nearest bridge. Candidates this circuitous are discarded outright, not
// scored, so they can never win on scenery alone.
const MAX_DETOUR_RATIO = 1.5;

// Even in the "nothing hit even +/-10%" fallback, a route this far from the
// requested distance isn't a reasonable "closest available" match -- it's a
// sign no plausible route exists for this start/distance/preference
// combination. Report infeasibility honestly instead of presenting it as a
// real result.
const MAX_ACCEPTABLE_FALLBACK_DEVIATION = 0.25;

const DEDUP_OVERLAP_THRESHOLD = 0.8; // >80% shared geometry = near-duplicate
const DEDUP_MATCH_METERS = 40; // how close two points need to be to count as "the same place"
const DEDUP_SAMPLE_COUNT = 20;

/** Merges bias-directed bearings with the even spread, dropping near-duplicates, capped at MAX_CANDIDATES. */
function buildBearingList(biasedBearings) {
  const merged = [];
  for (const b of [...biasedBearings, ...EVEN_BEARINGS]) {
    if (!merged.some((m) => Math.abs(m - b) < BEARING_MERGE_DEGREES)) merged.push(b);
  }
  return merged.slice(0, MAX_CANDIDATES);
}

async function biasedBearingsAround(center, radiusMeters) {
  try {
    const bias = await getDirectionalBias(center, Math.max(radiusMeters, 400));
    return [...bias.greeneryBearings, ...bias.scenicBearings];
  } catch {
    return []; // dataset hiccup — fall back to the even spread only
  }
}

/** Splits candidates into whichever tolerance tier (preferred, then max) actually has qualifiers. */
export function filterByTolerance(results, targetDistanceMeters) {
  const deviationOf = (r) => Math.abs(r.route.distanceMeters - targetDistanceMeters) / targetDistanceMeters;

  const preferred = results.filter((r) => deviationOf(r) <= TOLERANCE_PREFERRED);
  if (preferred.length > 0) return { candidates: preferred, tolerance: "preferred" };

  const max = results.filter((r) => deviationOf(r) <= TOLERANCE_MAX);
  if (max.length > 0) return { candidates: max, tolerance: "max" };

  return { candidates: results, tolerance: "none" };
}

function chainDistanceMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineDistance(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return total;
}

/** True if a route's actual walking distance is plausible for the straight-line
 *  waypoint chain that generated it -- see MAX_DETOUR_RATIO. */
function isPlausibleDetour(route, chainPoints) {
  const chain = chainDistanceMeters(chainPoints);
  if (chain === 0) return true;
  return route.distanceMeters / chain <= MAX_DETOUR_RATIO;
}

function overlapFraction(coordsA, coordsB, refLat, refLng) {
  const samples = sampleAlongRoute(coordsA, DEDUP_SAMPLE_COUNT);
  let matched = 0;
  for (const [lng, lat] of samples) {
    if (pointToRouteDistanceMeters(lat, lng, coordsB, refLat, refLng) <= DEDUP_MATCH_METERS) matched++;
  }
  return matched / samples.length;
}

/** True if routes A and B share more than DEDUP_OVERLAP_THRESHOLD of their geometry, in either direction. */
function areNearDuplicates(a, b) {
  const allCoords = [...a.route.coords, ...b.route.coords];
  const refLat = allCoords.reduce((sum, c) => sum + c[1], 0) / allCoords.length;
  const refLng = allCoords.reduce((sum, c) => sum + c[0], 0) / allCoords.length;
  const overlapAB = overlapFraction(a.route.coords, b.route.coords, refLat, refLng);
  const overlapBA = overlapFraction(b.route.coords, a.route.coords, refLat, refLng);
  return Math.max(overlapAB, overlapBA) > DEDUP_OVERLAP_THRESHOLD;
}

/** Keeps the first occurrence of each geometrically-distinct route, dropping near-duplicates. */
export function dedupeCandidates(candidates) {
  const kept = [];
  for (const c of candidates) {
    if (!kept.some((k) => areNearDuplicates(k, c))) kept.push(c);
  }
  return kept;
}

/**
 * Loop-shaped candidates: start -> [stop] -> B -> start. Bearings are drawn
 * from real nearby tree/landmark/waterfront density (so some candidates are
 * genuinely greenery- or scenery-directed, not just blindly rotated) plus an
 * even 8-way spread for balanced/efficient coverage.
 */
async function generateLoopCandidates(start, targetDistanceMeters, stop, stopPositionFraction = 0.5) {
  const legRadius = targetDistanceMeters / 3;
  const biased = await biasedBearingsAround(start, legRadius);
  const bearings = buildBearingList(biased);

  // A loop only has two legs to place a required stop on: the first (start
  // straight out to "a") or the second ("b" back toward start). fraction<=0.5
  // (early/middle) puts it on the first leg as before; fraction>0.5 (late)
  // puts it on the second leg instead, so a stop targeted near the end of
  // the run is actually visited near the end of the loop, not always first.
  const stopOnSecondLeg = stop && stopPositionFraction > 0.5;

  const attempts = await mapWithConcurrency(bearings, ROUTE_FETCH_CONCURRENCY, async (bearing) => {
    const a =
      stop && !stopOnSecondLeg ? { lat: stop.lat, lng: stop.lng } : destinationPoint(start.lat, start.lng, bearing, legRadius);
    const b =
      stop && stopOnSecondLeg ? { lat: stop.lat, lng: stop.lng } : destinationPoint(start.lat, start.lng, bearing + 130, legRadius);
    const chainPoints = [start, a, b, start];
    try {
      const route = await getWalkingRoute(chainPoints);
      if (!route) return null;
      if (!isPlausibleDetour(route, chainPoints)) return null;
      return { bearing, route };
    } catch {
      return null;
    }
  });

  const results = attempts.filter(Boolean);
  const { candidates: toleranceFiltered, tolerance } = filterByTolerance(results, targetDistanceMeters);
  return { candidates: dedupeCandidates(toleranceFiltered), tolerance };
}

/**
 * Point-to-point candidates: start -> [stop] -> end. The route genuinely
 * terminates at `end` — it never loops back to start. If the direct path
 * (through `stop` if given) is shorter than the target, detour points —
 * some bias-directed, some evenly spread — are tried off the start->end
 * midpoint to stretch toward the target while still ending at `end`. If the
 * direct path already meets or exceeds the target, it's used as-is (a fixed
 * two-point route can't be shortened).
 */
const MIN_DETOUR_METERS = 50; // below this, a synthesized detour point is just noise -- skip it

async function generatePointToPointCandidates(start, end, targetDistanceMeters, stop, stopPositionFraction = 0.5) {
  const throughPoints = stop ? [start, stop, end] : [start, end];
  const directRoute = await getWalkingRoute(throughPoints);
  if (!directRoute) {
    return { candidates: [], feasibility: { feasible: false, reason: "no_route" } };
  }

  if (directRoute.distanceMeters >= targetDistanceMeters) {
    const deviation = (directRoute.distanceMeters - targetDistanceMeters) / targetDistanceMeters;
    if (deviation <= TOLERANCE_MAX) {
      return {
        candidates: [{ bearing: null, route: directRoute }],
        feasibility: { feasible: true, tolerance: deviation <= TOLERANCE_PREFERRED ? "preferred" : "max" },
      };
    }
    return {
      candidates: [{ bearing: null, route: directRoute }],
      feasibility: { feasible: false, reason: "too_far", directMeters: directRoute.distanceMeters },
    };
  }

  // Direct path is shorter than target: stretch it with detour point(s) at
  // bias-directed and evenly-spread bearings. Without a stop, all the extra
  // distance is added at the start->end midpoint (as before). With a stop,
  // the extra distance is split between the leg before it and the leg after
  // it, weighted by stopPositionFraction -- otherwise ALL of it would land
  // after the stop regardless of the requested position (e.g. a stop
  // targeted at the route's midpoint would be reached almost immediately,
  // with the entire detour appended afterward, landing it near the start).
  const extraNeeded = targetDistanceMeters - directRoute.distanceMeters;
  const extraBefore = stop ? extraNeeded * stopPositionFraction : 0;
  const extraAfter = stop ? extraNeeded * (1 - stopPositionFraction) : extraNeeded;

  const beforeMid = stop ? { lat: (start.lat + stop.lat) / 2, lng: (start.lng + stop.lng) / 2 } : null;
  const afterMid = stop
    ? { lat: (stop.lat + end.lat) / 2, lng: (stop.lng + end.lng) / 2 }
    : { lat: (start.lat + end.lat) / 2, lng: (start.lng + end.lng) / 2 };

  const biased = await biasedBearingsAround(afterMid, Math.max(extraBefore, extraAfter) / 2 || 400);
  const bearings = buildBearingList(biased);

  const attempts = await mapWithConcurrency(bearings, ROUTE_FETCH_CONCURRENCY, async (bearing) => {
    const points = [start];
    if (extraBefore > MIN_DETOUR_METERS) {
      points.push(destinationPoint(beforeMid.lat, beforeMid.lng, bearing, extraBefore / 2));
    }
    if (stop) points.push(stop);
    if (extraAfter > MIN_DETOUR_METERS) {
      points.push(destinationPoint(afterMid.lat, afterMid.lng, bearing, extraAfter / 2));
    }
    points.push(end);
    try {
      const route = await getWalkingRoute(points);
      if (!route) return null;
      if (!isPlausibleDetour(route, points)) return null;
      return { bearing, route };
    } catch {
      return null;
    }
  });

  const results = attempts.filter(Boolean);
  const { candidates: toleranceFiltered, tolerance } = filterByTolerance(results, targetDistanceMeters);
  const deduped = dedupeCandidates(toleranceFiltered);
  const pool = deduped.length > 0 ? deduped : [{ bearing: null, route: directRoute }];

  const bestDistanceMeters = Math.min(...pool.map((c) => c.route.distanceMeters));

  return {
    candidates: pool,
    feasibility:
      tolerance !== "none"
        ? { feasible: true, reason: "detour_added", directMeters: directRoute.distanceMeters, bestDistanceMeters, tolerance }
        : { feasible: false, reason: "detour_insufficient", directMeters: directRoute.distanceMeters, bestDistanceMeters },
  };
}

/**
 * Generates a pool of candidate routes (up to 12, deduplicated to
 * genuinely distinct geometries) of roughly targetDistanceMeters from
 * `start`. If `end` is given, the route genuinely terminates there
 * (point-to-point); otherwise it loops back to `start`. `stop` is an
 * independent required waypoint (e.g. a coffee shop) that applies in either
 * shape.
 *
 * Distance is treated as a real constraint: candidates within ±5% of the
 * target are preferred; if none qualify, the search widens to ±10%; if even
 * that fails, `feasibility.feasible` is false and the caller should tell the
 * user honestly rather than presenting the result as if it matched.
 */
export async function generateCandidateRoutes(start, targetDistanceMeters, stop = null, end = null) {
  if (end) {
    return generatePointToPointCandidates(start, end, targetDistanceMeters, stop);
  }

  if (stop) {
    const directMeters = haversineDistance(start.lat, start.lng, stop.lat, stop.lng);
    const minRoundTrip = directMeters * 2;
    if (minRoundTrip > targetDistanceMeters * (1 + TOLERANCE_MAX)) {
      const route = await getWalkingRoute([start, stop, start]);
      return {
        candidates: route ? [{ bearing: null, route }] : [],
        feasibility: { feasible: false, reason: "too_far", directMeters },
      };
    }
  }

  const { candidates, tolerance } = await generateLoopCandidates(start, targetDistanceMeters, stop);

  if (candidates.length === 0) {
    return { candidates: [], feasibility: { feasible: false, reason: "no_plausible_route" } };
  }

  if (tolerance === "none") {
    const bestDistanceMeters = Math.min(...candidates.map((c) => c.route.distanceMeters));
    const bestDeviation = Math.abs(bestDistanceMeters - targetDistanceMeters) / targetDistanceMeters;

    if (bestDeviation > MAX_ACCEPTABLE_FALLBACK_DEVIATION) {
      return {
        candidates: [],
        feasibility: {
          feasible: false,
          reason: "no_plausible_route",
          bestDistanceMeters,
          bestDeviationPct: Math.round(bestDeviation * 1000) / 10,
        },
      };
    }

    return {
      candidates,
      feasibility: {
        feasible: false,
        reason: "off_target",
        directMeters: stop ? haversineDistance(start.lat, start.lng, stop.lat, stop.lng) : null,
        bestDistanceMeters,
      },
    };
  }

  return { candidates, feasibility: { feasible: true, tolerance } };
}
