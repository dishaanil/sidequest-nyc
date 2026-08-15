import { destinationPoint } from "./geo";
import { getWalkingRoute } from "./mapboxApi";

const BASE_BEARINGS = [20, 110, 200, 290]; // spread candidates around the compass

/**
 * Generates loop-shaped candidate routes of roughly targetDistanceMeters,
 * starting and ending at `start`. Each candidate is a triangular loop
 * (start -> A -> B -> start) sent to Mapbox Directions for a real
 * street-network walking route, then filtered to ones close to the target
 * distance — the API can't guarantee exact loop length, so we generate a
 * few and keep what's usable.
 */
export async function generateCandidateRoutes(start, targetDistanceMeters, count = 4) {
  const legRadius = targetDistanceMeters / 3; // 3 legs roughly summing to target

  const attempts = BASE_BEARINGS.slice(0, count).map(async (bearing) => {
    const a = destinationPoint(start.lat, start.lng, bearing, legRadius);
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

  // Keep candidates within 35% of the target distance if possible; if none
  // qualify, fall back to whatever we got rather than returning nothing.
  const tolerance = 0.35;
  const withinTolerance = results.filter(
    (r) =>
      Math.abs(r.route.distanceMeters - targetDistanceMeters) / targetDistanceMeters <= tolerance
  );

  return withinTolerance.length > 0 ? withinTolerance : results;
}
