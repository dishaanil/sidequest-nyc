import { destinationPoint, haversineDistance } from "./geo";
import { getWalkingRoute } from "./mapboxApi";

const BASE_BEARINGS = [20, 110, 200, 290]; // spread candidates around the compass
const TOLERANCE = 0.35; // how far from target distance is still "close enough"

/**
 * Generates loop-shaped candidate routes of roughly targetDistanceMeters,
 * starting and ending at `start`. Each candidate is a triangular loop
 * (start -> A -> B -> start) sent to Mapbox Directions for a real
 * street-network walking route, then filtered to ones close to the target
 * distance — the API can't guarantee exact loop length, so we generate a
 * few and keep what's usable.
 *
 * If `stop` is given (a required waypoint, e.g. a coffee shop, library, or
 * a parsed `end` location), every candidate is forced to pass through it in
 * place of the first generated point — no smart placement, just "the route
 * must pass through this point."
 *
 * Returns { candidates, feasibility }. `feasibility.feasible` is false when
 * the required waypoint makes the requested distance unreachable — either
 * because it's too far for any loop of that size (a straight there-and-back
 * already blows past the target) or because the best candidate still lands
 * well outside tolerance. The caller should surface `feasibility` to the
 * user rather than silently presenting an off-target route as if it matched
 * the request.
 */
export async function generateCandidateRoutes(start, targetDistanceMeters, count = 4, stop = null) {
  if (stop) {
    const directMeters = haversineDistance(start.lat, start.lng, stop.lat, stop.lng);
    const minRoundTrip = directMeters * 2; // straight-line lower bound; real streets will be longer

    if (minRoundTrip > targetDistanceMeters * (1 + TOLERANCE)) {
      // No loop of the requested size can make sense here — adding an
      // arbitrary extra detour on top would only make it worse. Fall back
      // to the single most direct route through the waypoint instead.
      const route = await getWalkingRoute([start, stop, start]);
      return {
        candidates: route ? [{ bearing: null, route }] : [],
        feasibility: { feasible: false, reason: "too_far", directMeters, targetDistanceMeters },
      };
    }
  }

  const legRadius = targetDistanceMeters / 3; // 3 legs roughly summing to target

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

  // Keep candidates within tolerance of the target distance if possible; if
  // none qualify, fall back to whatever we got rather than returning nothing.
  const withinTolerance = results.filter(
    (r) => Math.abs(r.route.distanceMeters - targetDistanceMeters) / targetDistanceMeters <= TOLERANCE
  );
  const candidates = withinTolerance.length > 0 ? withinTolerance : results;

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
        targetDistanceMeters,
      };
    }
  }

  return { candidates, feasibility };
}
