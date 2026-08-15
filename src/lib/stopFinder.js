import { haversineDistance, routeBoundingBox } from "./geo";

const COFFEE_DATASET_ID = "43nn-pn8j"; // DOHMH Restaurant Inspection Results
const LIBRARY_DATASET_ID = "feuq-due4"; // LIBRARY

const SEARCH_RADIUS_METERS = 2000; // look within ~1.25mi of the start point

async function queryCoffeeShops(bbox) {
  const url = new URL(`https://data.cityofnewyork.us/resource/${COFFEE_DATASET_ID}.json`);
  url.searchParams.set("$select", "dba,latitude,longitude");
  url.searchParams.set(
    "$where",
    [
      "cuisine_description='Coffee/Tea'",
      "latitude IS NOT NULL",
      `latitude between ${bbox.minLat} and ${bbox.maxLat}`,
      `longitude between ${bbox.minLng} and ${bbox.maxLng}`,
    ].join(" AND ")
  );
  url.searchParams.set("$limit", "200");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Coffee shop lookup failed: ${res.status}`);
  const rows = await res.json();
  return rows
    .map((r) => ({ name: r.dba, lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) }))
    .filter((r) => !Number.isNaN(r.lat) && !Number.isNaN(r.lng));
}

async function queryLibraries(bbox) {
  const url = new URL(`https://data.cityofnewyork.us/resource/${LIBRARY_DATASET_ID}.json`);
  url.searchParams.set("$select", "name,the_geom");
  // the_geom is a Point column, so a bbox filter needs within_box rather than
  // plain lat/long comparisons: within_box(field, northLat, westLng, southLat, eastLng).
  url.searchParams.set(
    "$where",
    `within_box(the_geom, ${bbox.maxLat}, ${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng})`
  );
  url.searchParams.set("$limit", "200");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Library lookup failed: ${res.status}`);
  const rows = await res.json();
  return rows
    .map((r) => ({
      name: r.name,
      lat: r.the_geom?.coordinates?.[1],
      lng: r.the_geom?.coordinates?.[0],
    }))
    .filter((r) => typeof r.lat === "number" && typeof r.lng === "number");
}

const FINDERS = {
  coffee: { query: queryCoffeeShops, label: "coffee shop" },
  library: { query: queryLibraries, label: "library" },
};

export const STOP_TYPES = Object.keys(FINDERS);

/**
 * Finds the real stop of the given type nearest to `searchCenter` (within a
 * fixed search radius), to be inserted as a required waypoint. `searchCenter`
 * is not necessarily the trip's start point -- callers pass an "ideal
 * position along the route" point (see stopPosition.js) so a stop type that
 * defaults to the middle or end of the run doesn't just get the POI nearest
 * to where the runner laces up. Returns null if none exists nearby — the
 * caller falls back to no stop.
 */
export async function findNearestStop(searchCenter, stopType) {
  const finder = FINDERS[stopType];
  if (!finder) return null;

  const bbox = routeBoundingBox([[searchCenter.lng, searchCenter.lat]], SEARCH_RADIUS_METERS);
  const candidates = await finder.query(bbox);
  if (candidates.length === 0) return null;

  let nearest = null;
  let nearestDist = Infinity;
  for (const c of candidates) {
    const d = haversineDistance(searchCenter.lat, searchCenter.lng, c.lat, c.lng);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = c;
    }
  }
  return { ...nearest, type: stopType, typeLabel: finder.label };
}
