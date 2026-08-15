import { haversineDistance, pointInPolygonRing, pointToRouteDistanceMeters, routeBoundingBox, sampleAlongRoute } from "./geo";
import { fetchJsonWithRetry } from "./httpRetry";

const TREE_DATASET_ID = "uvpi-gqnh"; // 2015 Street Tree Census
const LANDMARK_DATASET_ID = "ncre-qhxs"; // Designated and Calendared Buildings and Sites
const WATERFRONT_DATASET_ID = "9y58-8zvz"; // Waterfront Public Access Areas (WPAAs)
const PARK_DATASET_ID = "enfh-gkve"; // Parks Properties (real polygons, verified live)

const TREE_BUFFER_METERS = 50;
const LANDMARK_BUFFER_METERS = 75;
const WATERFRONT_BUFFER_METERS = 75;
const PARK_BUFFER_METERS = 30;

const EXPOSURE_SAMPLE_COUNT = 25; // points sampled evenly along the route for the exposure calc

// Engineering assumption, not a precise citywide statistic: 20 trees per
// 100m of route (within the 50m buffer, i.e. roughly both sides of the
// street) is treated as the "100/100" ceiling for tree density — denser
// than a typical NYC block, reserved for genuinely tree-lined stretches.
// Tunable; documented here so it can be defended or adjusted.
const TREE_DENSITY_REFERENCE_PER_100M = 20;

const DISTANCE_SATURATION = 0.4; // deviation fraction at which Running Quality bottoms out at 0

async function queryLatLngPoints(datasetId, selectFields, bbox) {
  const url = new URL(`https://data.cityofnewyork.us/resource/${datasetId}.json`);
  url.searchParams.set("$select", selectFields);
  url.searchParams.set(
    "$where",
    [`latitude between ${bbox.minLat} and ${bbox.maxLat}`, `longitude between ${bbox.minLng} and ${bbox.maxLng}`].join(" AND ")
  );
  url.searchParams.set("$limit", "5000");
  return fetchJsonWithRetry(url.toString());
}

async function queryTrees(bbox) {
  const rows = await queryLatLngPoints(TREE_DATASET_ID, "latitude,longitude", bbox);
  return rows
    .map((r) => ({ lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) }))
    .filter((p) => !Number.isNaN(p.lat) && !Number.isNaN(p.lng));
}

async function queryLandmarks(bbox) {
  const rows = await queryLatLngPoints(LANDMARK_DATASET_ID, "lm_name,latitude,longitude", bbox);
  return rows
    .map((r) => ({ name: r.lm_name, lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) }))
    .filter((p) => !Number.isNaN(p.lat) && !Number.isNaN(p.lng));
}

async function queryWaterfront(bbox) {
  const url = new URL(`https://data.cityofnewyork.us/resource/${WATERFRONT_DATASET_ID}.json`);
  url.searchParams.set("$select", "wpaa_name,the_geom");
  url.searchParams.set("$where", `within_box(the_geom, ${bbox.maxLat}, ${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng})`);
  url.searchParams.set("$limit", "5000");
  const rows = await fetchJsonWithRetry(url.toString());
  return rows
    .map((r) => ({ name: r.wpaa_name, lat: r.the_geom?.coordinates?.[1], lng: r.the_geom?.coordinates?.[0] }))
    .filter((p) => typeof p.lat === "number" && typeof p.lng === "number");
}

async function queryParks(bbox) {
  const url = new URL(`https://data.cityofnewyork.us/resource/${PARK_DATASET_ID}.json`);
  url.searchParams.set("$select", "signname,multipolygon,acres");
  url.searchParams.set("$where", `within_box(multipolygon, ${bbox.maxLat}, ${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng})`);
  url.searchParams.set("$limit", "500");
  const rows = await fetchJsonWithRetry(url.toString());
  return rows
    .filter((r) => r.multipolygon?.coordinates)
    .map((r) => ({ name: r.signname, acres: parseFloat(r.acres), polygons: r.multipolygon.coordinates }));
}

/** Fraction of sampled route points within `bufferMeters` of at least one point in `points`. */
function pointExposureFraction(samples, points, bufferMeters) {
  if (points.length === 0) return 0;
  let exposed = 0;
  for (const [lng, lat] of samples) {
    if (points.some((p) => haversineDistance(lat, lng, p.lat, p.lng) <= bufferMeters)) exposed++;
  }
  return exposed / samples.length;
}

/** Fraction of sampled route points inside (or within bufferMeters of the boundary of) at least one park polygon. */
function parkExposureFraction(samples, parks, bufferMeters) {
  if (parks.length === 0) return 0;
  let exposed = 0;
  for (const [lng, lat] of samples) {
    const near = parks.some((park) =>
      park.polygons.some((polygon) => {
        const outerRing = polygon[0];
        if (pointInPolygonRing(lat, lng, outerRing)) return true;
        return outerRing.some(([rLng, rLat]) => haversineDistance(lat, lng, rLat, rLng) <= bufferMeters);
      })
    );
    if (near) exposed++;
  }
  return exposed / samples.length;
}

function clampScore(x) {
  return Math.max(0, Math.min(100, Math.round(x)));
}

/**
 * Computes deterministic 0-100 scores (Greenery, Scenic, Running Quality)
 * for a route from real NYC Open Data geometry — never LLM-estimated.
 *
 * - Greenery = 0.6 * tree_density_score + 0.4 * park_exposure_%
 * - Scenic   = 0.35*waterfront_score + 0.25*park_score + 0.20*landmark_score + 0.20*greenery_score
 * - Running Quality = 100 * distance_accuracy (100 at exact target, 0 by 40%+ deviation)
 *
 * "Exposure" for landmark/waterfront/park scores means the % of the
 * route's LENGTH (25 evenly-sampled points) that passes near that feature
 * type — not a raw count — so a single dense cluster (e.g. a historic
 * district with hundreds of individually-designated buildings) can't
 * dominate the score beyond the actual stretch of route it covers.
 */
export async function computeScoreBreakdown(routeCoords, routeDistanceMeters, targetDistanceMeters) {
  const bufferForQuery = Math.max(TREE_BUFFER_METERS, LANDMARK_BUFFER_METERS, WATERFRONT_BUFFER_METERS, PARK_BUFFER_METERS);
  const bbox = routeBoundingBox(routeCoords, bufferForQuery);

  const [trees, landmarks, waterfront, parks] = await Promise.all([
    queryTrees(bbox),
    queryLandmarks(bbox),
    queryWaterfront(bbox),
    queryParks(bbox),
  ]);

  const samples = sampleAlongRoute(routeCoords, EXPOSURE_SAMPLE_COUNT);
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const midLng = (bbox.minLng + bbox.maxLng) / 2;

  // Raw counts within buffer of the route LINE (not just the bbox) — this is
  // the "evidence" shown to the user, distinct from the exposure % used for
  // the actual score.
  const treesNearRoute = trees.filter((t) => pointToRouteDistanceMeters(t.lat, t.lng, routeCoords, midLat, midLng) <= TREE_BUFFER_METERS);
  const landmarksNearRoute = landmarks.filter(
    (l) => pointToRouteDistanceMeters(l.lat, l.lng, routeCoords, midLat, midLng) <= LANDMARK_BUFFER_METERS
  );
  const waterfrontNearRoute = waterfront.filter(
    (w) => pointToRouteDistanceMeters(w.lat, w.lng, routeCoords, midLat, midLng) <= WATERFRONT_BUFFER_METERS
  );

  // Exposure fractions: the actual score inputs.
  const landmarkExposure = pointExposureFraction(samples, landmarks, LANDMARK_BUFFER_METERS);
  const waterfrontExposure = pointExposureFraction(samples, waterfront, WATERFRONT_BUFFER_METERS);
  const parkExposure = parkExposureFraction(samples, parks, PARK_BUFFER_METERS);

  const treeDensityPer100m = treesNearRoute.length / (routeDistanceMeters / 100);
  const treeDensityScore = Math.min(100, (treeDensityPer100m / TREE_DENSITY_REFERENCE_PER_100M) * 100);
  const greeneryScore = clampScore(0.6 * treeDensityScore + 0.4 * (parkExposure * 100));

  const landmarkScore = clampScore(landmarkExposure * 100);
  const waterfrontScore = clampScore(waterfrontExposure * 100);
  const parkScore = clampScore(parkExposure * 100);

  // Scenic's "greenery" term uses tree density ONLY, not the full
  // greenery_score — greenery_score already folds in park exposure (0.4
  // weight), so reusing it here would double-count park (effective weight
  // 0.25 + 0.20*0.4 = 0.33 instead of the stated 0.25). Excluding it keeps
  // park's effective weight in Scenic exactly at 0.25.
  const greeneryForScenic = clampScore(treeDensityScore);
  const scenicScore = clampScore(0.35 * waterfrontScore + 0.25 * parkScore + 0.2 * landmarkScore + 0.2 * greeneryForScenic);

  const deviation = Math.abs(routeDistanceMeters - targetDistanceMeters) / targetDistanceMeters;
  const runningQualityScore = clampScore(Math.max(0, 1 - deviation / DISTANCE_SATURATION) * 100);

  return {
    greeneryScore,
    scenicScore,
    runningQualityScore,
    components: { landmarkScore, waterfrontScore, parkScore, greeneryForScenic },
    evidence: {
      treeCount: treesNearRoute.length,
      treeBufferMeters: TREE_BUFFER_METERS,
      treeDensityPer100m: Number(treeDensityPer100m.toFixed(2)),
      treeDensityReferencePer100m: TREE_DENSITY_REFERENCE_PER_100M,
      landmarkCount: landmarksNearRoute.length,
      landmarkBufferMeters: LANDMARK_BUFFER_METERS,
      landmarkExposurePct: Math.round(landmarkExposure * 100),
      waterfrontCount: waterfrontNearRoute.length,
      waterfrontBufferMeters: WATERFRONT_BUFFER_METERS,
      waterfrontExposurePct: Math.round(waterfrontExposure * 100),
      parkExposurePct: Math.round(parkExposure * 100),
      parkBufferMeters: PARK_BUFFER_METERS,
      nearbyParkNames: [...new Set(parks.map((p) => p.name).filter(Boolean))].slice(0, 5),
      distanceDeviationPct: Math.round(deviation * 1000) / 10,
      sampleCount: EXPOSURE_SAMPLE_COUNT,
    },
  };
}
