import { destinationPoint, haversineDistance } from "./geo";
import { getWalkingRoute } from "./mapboxApi";

const BASE_BEARINGS = [20, 110, 200, 290]; // spread candidates around the compass
const TOLERANCE = 0.35; // how far from target distance is still "close enough"

/**
 * Loop-shaped candidates: start -> [stop] -> B -> start. Used whenever no
 * distinct `end` is given — the classic Tier 0/1/2 shape.
 */
async function generateLoopCandidates(start, targetDistanceMeters, count, stop) {
  const legRadius = targetDistanceMeters / 3;

  const attempts = BASE_BEARINGS.slice(0, count).map(async (bearing) => {
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

  const results = (await Promise.all(attempts)).filter(Boolean);
  const withinTolerance = results.filter(
    (r) => Math.abs(r.route.distanceMeters - targetDistanceMeters) / targetDistanceMeters <= TOLERANCE
  );
  return withinTolerance.length > 0 ? withinTolerance : results;
}

/**
 * Point-to-point candidates: start -> [stop] -> end. The route genuinely
 * terminates at `end` — it never loops back to start. If the direct path
 * (through `stop` if given) is shorter than the target, a detour point is
 * added off the start->end line, at a few bearings, to stretch toward the
 * target while still actually ending at `end`. If the direct path already
 * meets or exceeds the target, it's used as-is (a fixed two-point route
 * can't be shortened).
 */
async function generatePointToPointCandidates(start, end, targetDistanceMeters, count, stop) {
  const throughPoints = stop ? [start, stop, end] : [start, end];
  const directRoute = await getWalkingRoute(throughPoints);
  if (!directRoute) {
    return { candidates: [], feasibility: { feasible: false, reason: "no_route" } };
  }

  if (directRoute.distanceMeters >= targetDistanceMeters) {
    const deviation = (directRoute.distanceMeters - targetDistanceMeters) / targetDistanceMeters;
    const feasible = deviation <= TOLERANCE;
    return {
      candidates: [{ bearing: null, route: directRoute }],
      feasibility: feasible
        ? { feasible: true }
        : { feasible: false, reason: "too_far", directMeters: directRoute.distanceMeters },
    };
  }

  // Direct path is shorter than target: stretch it with a detour off the
  // start->end midpoint, tried at a few bearings for variety.
  const midLat = (start.lat + end.lat) / 2;
  const midLng = (start.lng + end.lng) / 2;
  const extraNeeded = targetDistanceMeters - directRoute.distanceMeters;
  const detourRadius = extraNeeded / 2; // rough: out to the detour point and back on line

  const attempts = BASE_BEARINGS.slice(0, count).map(async (bearing) => {
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

  const results = (await Promise.all(attempts)).filter(Boolean);
  const withinTolerance = results.filter(
    (r) => Math.abs(r.route.distanceMeters - targetDistanceMeters) / targetDistanceMeters <= TOLERANCE
  );
  const candidates =
    withinTolerance.length > 0 ? withinTolerance : results.length > 0 ? results : [{ bearing: null, route: directRoute }];

  const bestDistanceMeters = Math.min(...candidates.map((c) => c.route.distanceMeters));
  const bestDeviation = Math.abs(bestDistanceMeters - targetDistanceMeters) / targetDistanceMeters;

  return {
    candidates,
    feasibility: {
      feasible: bestDeviation <= TOLERANCE,
      reason: "detour_added",
      directMeters: directRoute.distanceMeters,
      bestDistanceMeters,
    },
  };
}

/**
 * Generates candidate routes of roughly targetDistanceMeters from `start`.
 * If `end` is given, the route genuinely terminates there (point-to-point);
 * otherwise it loops back to `start`. `stop` is an independent required
 * waypoint (e.g. a coffee shop) that applies in either shape — "on the way"
 * either around the loop or en route to `end`.
 *
 * Returns { candidates, feasibility }. `feasibility.reason` explains any
 * distance mismatch worth surfacing to the user ("too_far": even the most
 * direct option exceeds the target; "detour_added": the direct path was
 * shorter than target, so we added a stretch; "off_target": loop mode
 * couldn't get within tolerance despite trying).
 */
export async function generateCandidateRoutes(start, targetDistanceMeters, count = 4, stop = null, end = null) {
  if (end) {
    return generatePointToPointCandidates(start, end, targetDistanceMeters, count, stop);
  }

  if (stop) {
    const directMeters = haversineDistance(start.lat, start.lng, stop.lat, stop.lng);
    const minRoundTrip = directMeters * 2;
    if (minRoundTrip > targetDistanceMeters * (1 + TOLERANCE)) {
      const route = await getWalkingRoute([start, stop, start]);
      return {
        candidates: route ? [{ bearing: null, route }] : [],
        feasibility: { feasible: false, reason: "too_far", directMeters },
      };
    }
  }

  const candidates = await generateLoopCandidates(start, targetDistanceMeters, count, stop);

  let feasibility = { feasible: true };
  if (stop && candidates.length > 0) {
    const bestDistanceMeters = Math.min(...candidates.map((c) => c.route.distanceMeters));
    const deviation = Math.abs(bestDistanceMeters - targetDistanceMeters) / targetDistanceMeters;
    if (deviation > TOLERANCE) {
      feasibility = {
        feasible: false,
        reason: "off_target",
        directMeters: haversineDistance(start.lat, start.lng, stop.lat, stop.lng),
        bestDistanceMeters,
      };
    }
  }

  return { candidates, feasibility };
}
