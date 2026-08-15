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
async function generateLoopCandidates(start, targetDistanceMeters, stop) {
  const legRadius = targetDistanceMeters / 3;
  const biased = await biasedBearingsAround(start, legRadius);
  const bearings = buildBearingList(biased);

  const attempts = await mapWithConcurrency(bearings, ROUTE_FETCH_CONCURRENCY, async (bearing) => {
    const a = stop ? { lat: stop.lat, lng: stop.lng } : destinationPoint(start.lat, start.lng, bearing, legRadius);
    const b = destinationPoint(start.lat, start.lng, bearing + 130, legRadius);
    try {
      const route = await getWalkingRoute([start, a, b, start]);
      if (!route) return null;
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
async function generatePointToPointCandidates(start, end, targetDistanceMeters, stop) {
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

  // Direct path is shorter than target: stretch it with a detour off the
  // start->end midpoint, at bias-directed and evenly-spread bearings.
  const midLat = (start.lat + end.lat) / 2;
  const midLng = (start.lng + end.lng) / 2;
  const extraNeeded = targetDistanceMeters - directRoute.distanceMeters;
  const detourRadius = extraNeeded / 2;

  const biased = await biasedBearingsAround({ lat: midLat, lng: midLng }, detourRadius);
  const bearings = buildBearingList(biased);

  const attempts = await mapWithConcurrency(bearings, ROUTE_FETCH_CONCURRENCY, async (bearing) => {
    const detour = destinationPoint(midLat, midLng, bearing, detourRadius);
    const points = stop ? [start, stop, detour, end] : [start, detour, end];
    try {
      const route = await getWalkingRoute(points);
      if (!route) return null;
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

  if (tolerance === "none" && candidates.length > 0) {
    const bestDistanceMeters = Math.min(...candidates.map((c) => c.route.distanceMeters));
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
