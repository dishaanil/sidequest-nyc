import { bearingBetween, routeBoundingBox } from "./geo";

const TREE_DATASET_ID = "uvpi-gqnh"; // 2015 Street Tree Census
const LANDMARK_DATASET_ID = "ncre-qhxs"; // Designated and Calendared Buildings and Sites
const WATERFRONT_DATASET_ID = "9y58-8zvz"; // Waterfront Public Access Areas (WPAAs)

const SECTOR_COUNT = 8; // 45° compass sectors
const SECTOR_DEGREES = 360 / SECTOR_COUNT;

async function queryLatLngPoints(datasetId, bbox) {
  const url = new URL(`https://data.cityofnewyork.us/resource/${datasetId}.json`);
  url.searchParams.set("$select", "latitude,longitude");
  url.searchParams.set(
    "$where",
    [
      `latitude between ${bbox.minLat} and ${bbox.maxLat}`,
      `longitude between ${bbox.minLng} and ${bbox.maxLng}`,
    ].join(" AND ")
  );
  url.searchParams.set("$limit", "2000");
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const rows = await res.json();
  return rows
    .map((r) => ({ lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) }))
    .filter((p) => !Number.isNaN(p.lat) && !Number.isNaN(p.lng));
}

async function queryWaterfrontPoints(bbox) {
  const url = new URL(`https://data.cityofnewyork.us/resource/${WATERFRONT_DATASET_ID}.json`);
  url.searchParams.set("$select", "the_geom");
  url.searchParams.set(
    "$where",
    `within_box(the_geom, ${bbox.maxLat}, ${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng})`
  );
  url.searchParams.set("$limit", "2000");
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const rows = await res.json();
  return rows
    .map((r) => ({ lat: r.the_geom?.coordinates?.[1], lng: r.the_geom?.coordinates?.[0] }))
    .filter((p) => typeof p.lat === "number" && typeof p.lng === "number");
}

function sectorIndex(bearingDeg) {
  return Math.floor((((bearingDeg % 360) + 360) % 360) / SECTOR_DEGREES);
}

function topSectorBearings(counts, n) {
  return counts
    .map((count, i) => ({ i, count }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, n)
    .map((x) => x.i * SECTOR_DEGREES + SECTOR_DEGREES / 2);
}

/**
 * Buckets real nearby trees and landmarks/waterfront points into 8 compass
 * sectors around `center`, so candidate route generation can be biased
 * toward "there's actually more greenery/scenery this way" instead of
 * picking bearings blindly. Falls back to empty arrays (caller should use a
 * plain even bearing spread) if the queries fail.
 */
export async function getDirectionalBias(center, radiusMeters) {
  const bbox = routeBoundingBox([[center.lng, center.lat]], radiusMeters);

  const [trees, landmarks, waterfront] = await Promise.all([
    queryLatLngPoints(TREE_DATASET_ID, bbox),
    queryLatLngPoints(LANDMARK_DATASET_ID, bbox),
    queryWaterfrontPoints(bbox),
  ]);

  const treeSectors = new Array(SECTOR_COUNT).fill(0);
  const scenicSectors = new Array(SECTOR_COUNT).fill(0);

  for (const t of trees) {
    treeSectors[sectorIndex(bearingBetween(center.lat, center.lng, t.lat, t.lng))]++;
  }
  for (const p of [...landmarks, ...waterfront]) {
    scenicSectors[sectorIndex(bearingBetween(center.lat, center.lng, p.lat, p.lng))]++;
  }

  return {
    greeneryBearings: topSectorBearings(treeSectors, 3),
    scenicBearings: topSectorBearings(scenicSectors, 3),
  };
}
