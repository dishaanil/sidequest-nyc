// Public Mapbox token (pk. prefix) — Mapbox's own access model expects this
// to ship in client bundles; it's secured via URL/referrer restrictions on
// Mapbox's dashboard, not by being kept out of source. (Base44's `secrets`
// store only reaches backend functions, not the Vite frontend build, so a
// build-time secret isn't an option here — confirmed by testing.)
const MAPBOX_TOKEN =
  "pk.eyJ1IjoiZGlzaGFuaWwiLCJhIjoiY21zdWk2OGk5MHZkejJ5cHpiaTkybzg2cSJ9.TXJ0dETLPo4VBOXhpHkSGA";

// Tightened to the actual 5-boroughs footprint. The previous box's max
// longitude (-73.68) reached past NYC's true eastern edge into western
// Nassau County (Port Washington, Great Neck, etc.) on Long Island, so a
// mismatched real-world result there would still pass the bbox filter.
const NYC_BBOX = "-74.26,40.49,-73.75,40.92";
const NYC_PROXIMITY = "-73.9857,40.7484"; // Midtown Manhattan, for ranking bias

export async function geocodeAddress(query) {
  // Search Box API (not the older Geocoding v5 API): it has real POI/landmark
  // coverage (university buildings, libraries, etc.) that v5's `mapbox.places`
  // endpoint largely lacks — v5 returned a street literally named "Library
  // Drive" in Port Washington, NY for "bobst library" instead of NYU's actual
  // Bobst Library, because it doesn't index that POI at all.
  const url = new URL("https://api.mapbox.com/search/searchbox/v1/forward");
  url.searchParams.set("q", query);
  url.searchParams.set("access_token", MAPBOX_TOKEN);
  url.searchParams.set("bbox", NYC_BBOX);
  url.searchParams.set("proximity", NYC_PROXIMITY);
  url.searchParams.set("limit", "1");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature) throw new Error(`Couldn't find a location for "${query}" in NYC.`);
  const [lng, lat] = feature.geometry.coordinates;
  return {
    lat,
    lng,
    name: feature.properties.name,
    placeName: feature.properties.full_address || feature.properties.place_formatted,
  };
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
