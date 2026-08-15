const EARTH_RADIUS_M = 6371000;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

export function haversineDistance(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export function destinationPoint(lat, lng, bearingDeg, distanceM) {
  const bearing = toRad(bearingDeg);
  const lat1 = toRad(lat);
  const lng1 = toRad(lng);
  const angularDistance = distanceM / EARTH_RADIUS_M;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  return { lat: toDeg(lat2), lng: toDeg(lng2) };
}

/** Initial compass bearing (0-360°) from point 1 to point 2. */
export function bearingBetween(lat1, lng1, lat2, lng2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLng = toRad(lng2 - lng1);
  const y = Math.sin(deltaLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function routeLengthMeters(coords) {
  // coords: [[lng, lat], ...]
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1];
    const [lng2, lat2] = coords[i];
    total += haversineDistance(lat1, lng1, lat2, lng2);
  }
  return total;
}

/** Projects lat/lng to local meters on a flat tangent plane around a reference
 *  point. Accurate enough for the short (city-block-scale) distances used to
 *  score routes here — not meant for large-span geometry. */
function projectToLocalMeters(lat, lng, refLat, refLng) {
  const x = toRad(lng - refLng) * Math.cos(toRad(refLat)) * EARTH_RADIUS_M;
  const y = toRad(lat - refLat) * EARTH_RADIUS_M;
  return { x, y };
}

function pointToSegmentDistanceXY(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Minimum distance in meters from a point to a polyline (array of [lng, lat]). */
export function pointToRouteDistanceMeters(lat, lng, routeCoords, refLat, refLng) {
  const p = projectToLocalMeters(lat, lng, refLat, refLng);
  let min = Infinity;
  for (let i = 1; i < routeCoords.length; i++) {
    const a = projectToLocalMeters(routeCoords[i - 1][1], routeCoords[i - 1][0], refLat, refLng);
    const b = projectToLocalMeters(routeCoords[i][1], routeCoords[i][0], refLat, refLng);
    const d = pointToSegmentDistanceXY(p.x, p.y, a.x, a.y, b.x, b.y);
    if (d < min) min = d;
  }
  return min;
}

/** Evenly resamples a route polyline to n points by cumulative distance. */
export function sampleAlongRoute(coords, n) {
  if (coords.length <= n) return coords;
  const total = routeLengthMeters(coords);
  const step = total / (n - 1);
  const samples = [coords[0]];
  let acc = 0;
  let targetDist = step;
  for (let i = 1; i < coords.length && samples.length < n - 1; i++) {
    const [lng1, lat1] = coords[i - 1];
    const [lng2, lat2] = coords[i];
    const segLen = haversineDistance(lat1, lng1, lat2, lng2);
    while (acc + segLen >= targetDist && samples.length < n - 1) {
      const t = segLen === 0 ? 0 : (targetDist - acc) / segLen;
      samples.push([lng1 + (lng2 - lng1) * t, lat1 + (lat2 - lat1) * t]);
      targetDist += step;
    }
    acc += segLen;
  }
  samples.push(coords[coords.length - 1]);
  return samples;
}

/** Ray-casting point-in-polygon test. `ring` is [[lng,lat], ...] (outer ring; holes ignored). */
export function pointInPolygonRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [lngI, latI] = ring[i];
    const [lngJ, latJ] = ring[j];
    const intersects = latI > lat !== latJ > lat && lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function routeBoundingBox(coords, paddingMeters = 0) {
  let minLat = Infinity,
    maxLat = -Infinity,
    minLng = Infinity,
    maxLng = -Infinity;
  for (const [lng, lat] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  const latPad = paddingMeters / 111320;
  const midLat = (minLat + maxLat) / 2;
  const lngPad = paddingMeters / (111320 * Math.cos(toRad(midLat)) || 1);
  return {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLng: minLng - lngPad,
    maxLng: maxLng + lngPad,
  };
}
