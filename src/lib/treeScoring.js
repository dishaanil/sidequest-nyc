import { pointToRouteDistanceMeters, routeBoundingBox } from "./geo";

// 2015 Street Tree Census — a snapshot (not live), separate lat/long columns.
const TREE_DATASET_ID = "uvpi-gqnh";
const SODA_BASE = `https://data.cityofnewyork.us/resource/${TREE_DATASET_ID}.json`;
const BUFFER_METERS = 50; // "near the route" threshold

/**
 * Scores a route against real NYC tree data: pulls trees within the route's
 * bounding box from the Street Tree Census, then counts how many actually
 * fall within BUFFER_METERS of the route line (not just the bbox).
 */
export async function scoreRouteForTrees(routeCoords) {
  const bbox = routeBoundingBox(routeCoords, BUFFER_METERS);

  const where = [
    `latitude between ${bbox.minLat} and ${bbox.maxLat}`,
    `longitude between ${bbox.minLng} and ${bbox.maxLng}`,
  ].join(" AND ");

  const url = new URL(SODA_BASE);
  url.searchParams.set("$select", "latitude,longitude,spc_common");
  url.searchParams.set("$where", where);
  url.searchParams.set("$limit", "5000");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Tree Census query failed: ${res.status}`);
  const rows = await res.json();

  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const midLng = (bbox.minLng + bbox.maxLng) / 2;

  const nearbyTrees = rows
    .map((r) => ({
      lat: parseFloat(r.latitude),
      lng: parseFloat(r.longitude),
      species: r.spc_common,
    }))
    .filter((t) => !Number.isNaN(t.lat) && !Number.isNaN(t.lng))
    .filter(
      (t) => pointToRouteDistanceMeters(t.lat, t.lng, routeCoords, midLat, midLng) <= BUFFER_METERS
    );

  return {
    treeCount: nearbyTrees.length,
    bufferMeters: BUFFER_METERS,
    trees: nearbyTrees,
  };
}
