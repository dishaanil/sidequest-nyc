import { pointToRouteDistanceMeters, routeBoundingBox } from "./geo";
import { fetchJsonWithRetry } from "./httpRetry";

const LANDMARK_DATASET_ID = "ncre-qhxs"; // Designated and Calendared Buildings and Sites
const WATERFRONT_DATASET_ID = "9y58-8zvz"; // Waterfront Public Access Areas (WPAAs) — Access Points

const BUFFER_METERS = 75; // landmarks/waterfront access points are sparser than trees, so use a wider net

async function queryLandmarks(bbox) {
  const url = new URL(`https://data.cityofnewyork.us/resource/${LANDMARK_DATASET_ID}.json`);
  url.searchParams.set("$select", "lm_name,latitude,longitude");
  url.searchParams.set(
    "$where",
    [
      `latitude between ${bbox.minLat} and ${bbox.maxLat}`,
      `longitude between ${bbox.minLng} and ${bbox.maxLng}`,
    ].join(" AND ")
  );
  url.searchParams.set("$limit", "2000");

  const rows = await fetchJsonWithRetry(url.toString());
  return rows
    .map((r) => ({ name: r.lm_name, lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) }))
    .filter((r) => !Number.isNaN(r.lat) && !Number.isNaN(r.lng));
}

async function queryWaterfront(bbox) {
  const url = new URL(`https://data.cityofnewyork.us/resource/${WATERFRONT_DATASET_ID}.json`);
  url.searchParams.set("$select", "wpaa_name,the_geom");
  // the_geom is a Point column, so use within_box: (field, northLat, westLng, southLat, eastLng)
  url.searchParams.set(
    "$where",
    `within_box(the_geom, ${bbox.maxLat}, ${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng})`
  );
  url.searchParams.set("$limit", "2000");

  const rows = await fetchJsonWithRetry(url.toString());
  return rows
    .map((r) => ({
      name: r.wpaa_name,
      lat: r.the_geom?.coordinates?.[1],
      lng: r.the_geom?.coordinates?.[0],
    }))
    .filter((r) => typeof r.lat === "number" && typeof r.lng === "number");
}

function nearRoute(points, routeCoords, midLat, midLng) {
  return points.filter(
    (p) => pointToRouteDistanceMeters(p.lat, p.lng, routeCoords, midLat, midLng) <= BUFFER_METERS
  );
}

/**
 * Scores a route for "scenic" value: real NYC designated landmarks + real
 * waterfront access points within BUFFER_METERS of the route line, summed
 * with no hidden weighting — two real counts, added together.
 */
export async function scoreRouteForScenic(routeCoords) {
  const bbox = routeBoundingBox(routeCoords, BUFFER_METERS);
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const midLng = (bbox.minLng + bbox.maxLng) / 2;

  const [landmarks, waterfront] = await Promise.all([queryLandmarks(bbox), queryWaterfront(bbox)]);

  const nearbyLandmarks = nearRoute(landmarks, routeCoords, midLat, midLng);
  const nearbyWaterfront = nearRoute(waterfront, routeCoords, midLat, midLng);

  return {
    landmarkCount: nearbyLandmarks.length,
    waterfrontCount: nearbyWaterfront.length,
    total: nearbyLandmarks.length + nearbyWaterfront.length,
    bufferMeters: BUFFER_METERS,
    landmarks: nearbyLandmarks,
    waterfront: nearbyWaterfront,
  };
}
