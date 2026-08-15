import { geocodeAddress } from "./src/lib/mapboxApi.js";
import { generateCandidateRoutes } from "./src/lib/routeCandidates.js";
import { computeScoreBreakdown } from "./src/lib/scoreBreakdown.js";
import { rankByComposite } from "./src/lib/compositeScoring.js";
import { mapWithConcurrency } from "./src/lib/concurrency.js";
import { haversineDistance } from "./src/lib/geo.js";

const METERS_PER_MILE = 1609.34;

function maxDistFromStart(coords, start) {
  let max = 0;
  for (const [lng, lat] of coords) {
    const d = haversineDistance(start.lat, start.lng, lat, lng);
    if (d > max) max = d;
  }
  return max;
}

async function main() {
  const start = await geocodeAddress("Union Square, NYC");
  console.log("start:", start);

  const targetMeters = 5 * METERS_PER_MILE;
  const { candidates, feasibility } = await generateCandidateRoutes(start, targetMeters, null, null);
  console.log("feasibility:", feasibility);
  console.log("candidate count:", candidates.length);
  console.log(`target=${(targetMeters / METERS_PER_MILE).toFixed(2)}mi legRadius=${(targetMeters / 3).toFixed(0)}m\n`);

  for (const c of candidates) {
    const maxDist = maxDistFromStart(c.route.coords, start);
    console.log(
      `bearing=${c.bearing} routeDist=${(c.route.distanceMeters / METERS_PER_MILE).toFixed(2)}mi maxDistFromStart=${maxDist.toFixed(0)}m ratio_maxDist/target=${(maxDist / targetMeters).toFixed(2)}`
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
  console.log("maxDistFromStart:", maxDistFromStart(winner.route.coords, start).toFixed(0), "m");
  console.log("scenicScore:", winner.breakdown.scenicScore, "waterfrontScore:", winner.breakdown.components.waterfrontScore, "greeneryScore:", winner.breakdown.greeneryScore, "runningQualityScore:", winner.breakdown.runningQualityScore);
  console.log("compositeScore:", winner.compositeScore);

  console.log("\nAll scored candidates (sorted by composite):");
  composite.ranked.forEach((c, i) => {
    console.log(
      `${i + 1}. bearing=${c.bearing} dist=${(c.route.distanceMeters / METERS_PER_MILE).toFixed(2)}mi scenic=${c.breakdown.scenicScore} waterfront=${c.breakdown.components.waterfrontScore} rq=${c.breakdown.runningQualityScore} composite=${c.compositeScore.toFixed(3)} maxDistFromStart=${maxDistFromStart(c.route.coords, start).toFixed(0)}m`
    );
  });
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
