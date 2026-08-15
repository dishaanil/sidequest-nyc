import { geocodeAddress } from "./src/lib/mapboxApi.js";
import { generateCandidateRoutes } from "./src/lib/routeCandidates.js";
import { computeScoreBreakdown } from "./src/lib/scoreBreakdown.js";
import { rankByComposite } from "./src/lib/compositeScoring.js";
import { mapWithConcurrency } from "./src/lib/concurrency.js";

const METERS_PER_MILE = 1609.34;

function bbox(coords) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lng, lat] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

async function main() {
  const start = await geocodeAddress("Union Square, NYC");
  console.log("start:", start);

  const targetMeters = 5 * METERS_PER_MILE;
  const { candidates, feasibility } = await generateCandidateRoutes(start, targetMeters, null, null);
  console.log("feasibility:", feasibility);
  console.log("candidate count:", candidates.length);

  for (const c of candidates) {
    const bb = bbox(c.route.coords);
    const crossesHudson = bb.minLng < -74.02;
    console.log(
      `bearing=${c.bearing} dist=${(c.route.distanceMeters / METERS_PER_MILE).toFixed(2)}mi bbox.minLng=${bb.minLng.toFixed(4)} bbox.maxLat=${bb.maxLat.toFixed(4)} bbox.minLat=${bb.minLat.toFixed(4)} POSSIBLE_NJ_CROSSING=${crossesHudson}`
    );
  }

  const scored = await mapWithConcurrency(
    candidates,
    2,
    async (c) => ({ ...c, breakdown: await computeScoreBreakdown(c.route.coords, c.route.distanceMeters, targetMeters) }),
    250
  );

  const composite = rankByComposite(scored, "waterfront");
  const winner = composite.winner;
  console.log("\nWINNER:");
  console.log("distanceMeters:", winner.route.distanceMeters, "=", (winner.route.distanceMeters / METERS_PER_MILE).toFixed(2), "mi");
  console.log("scenicScore:", winner.breakdown.scenicScore, "greeneryScore:", winner.breakdown.greeneryScore, "runningQualityScore:", winner.breakdown.runningQualityScore);
  console.log("bbox:", bbox(winner.route.coords));
  console.log("compositeScore:", winner.compositeScore);

  console.log("\nAll scored candidates (sorted by composite):");
  composite.ranked.forEach((c, i) => {
    console.log(
      `${i + 1}. bearing=${c.bearing} dist=${(c.route.distanceMeters / METERS_PER_MILE).toFixed(2)}mi scenic=${c.breakdown.scenicScore} rq=${c.breakdown.runningQualityScore} composite=${c.compositeScore.toFixed(3)} bbox.minLng=${bbox(c.route.coords).minLng.toFixed(4)}`
    );
  });
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
