// Public Mapbox token (pk. prefix) — Mapbox's own access model expects this
// to ship in client bundles; it's secured via URL/referrer restrictions on
// Mapbox's dashboard, not by being kept out of source. (Base44's `secrets`
// store only reaches backend functions, not the Vite frontend build, so a
// build-time secret isn't an option here — confirmed by testing.)
const MAPBOX_TOKEN =
  "pk.eyJ1IjoiZGlzaGFuaWwiLCJhIjoiY21zdWw4YzNzMGh5djJ5cHBoM3BmZWFsZyJ9.KpA4uMWfZYDV6CT2DF-b7A";

const NYC_BBOX = "-74.26,40.49,-73.68,40.92"; // roughly all five boroughs

export async function geocodeAddress(query) {
  const url = new URL(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
  );
  url.searchParams.set("access_token", MAPBOX_TOKEN);
  url.searchParams.set("bbox", NYC_BBOX);
  url.searchParams.set("limit", "1");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature) throw new Error(`Couldn't find a location for "${query}" in NYC.`);
  const [lng, lat] = feature.center;
  return { lat, lng, placeName: feature.place_name };
}

/**
 * Requests a walking route through an ordered list of waypoints from the
 * Mapbox Directions API. waypoints: [{lat, lng}, ...] in visit order.
 */
export async function getWalkingRoute(waypoints) {
  const coordsStr = waypoints.map((w) => `${w.lng},${w.lat}`).join(";");
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/walking/${coordsStr}`);
  url.searchParams.set("access_token", MAPBOX_TOKEN);
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("overview", "full");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Directions request failed: ${res.status}`);
  const data = await res.json();
  const route = data.routes?.[0];
  if (!route) return null;
  return {
    coords: route.geometry.coordinates, // [[lng, lat], ...]
    distanceMeters: route.distance,
    durationSeconds: route.duration,
  };
}
