import { rankByComposite } from "./src/lib/compositeScoring.js";

const METERS_PER_MILE = 1609.34;
const TARGET = 2 * METERS_PER_MILE;

function pct(d) {
  return ((Math.abs(d - TARGET) / TARGET) * 100).toFixed(1) + "%";
}

function scoredCandidate(name, distanceMeters, treeCount, landmarkCount, waterfrontCount) {
  return {
    name,
    route: { distanceMeters },
    treeScore: { treeCount, bufferMeters: 50 },
    scenicScore: { landmarkCount, waterfrontCount, total: landmarkCount + waterfrontCount, bufferMeters: 75 },
  };
}

// Same fixtures as the previous run, so this is a direct before/after comparison.
const batch = [
  scoredCandidate("OnTarget_modest", 3218.68, 280, 35, 1),
  scoredCandidate("SlightlyOff_good", 3050, 320, 45, 2),
  scoredCandidate("PrettyButFar_43pctOff", 4600, 550, 90, 8),
  scoredCandidate("Modest_onTarget", 3300, 150, 15, 0),
  scoredCandidate("Middling", 3400, 250, 40, 3),
];

console.log("Same fixtures as before (preference = 'greenery'), NEW multiplicative formula:\n");
batch.forEach((c) =>
  console.log(
    `   ${c.name}: ${c.route.distanceMeters}m (${pct(c.route.distanceMeters)} off), trees=${c.treeScore.treeCount}, landmarks=${c.scenicScore.landmarkCount}, waterfront=${c.scenicScore.waterfrontCount}`
  )
);

const composite = rankByComposite(batch, "greenery", TARGET);
console.log(`\nWeights: trees=${composite.weights.trees.toFixed(3)}, landmarks=${composite.weights.landmarks.toFixed(3)}, waterfront=${composite.weights.waterfront.toFixed(3)}, distanceFloor=${composite.weights.distanceFloor}\n`);
console.log("Ranked (best first):");
composite.ranked.forEach((c, i) => {
  console.log(
    `   ${i + 1}. ${c.name}: composite=${c.compositeScore.toFixed(4)}  (sceneryScore=${c.sceneryScore.toFixed(3)}, distanceAccuracy=${c.normalized.distance.toFixed(3)})`
  );
});
console.log(`\nWinner: ${composite.winner.name}`);

const onTarget = composite.ranked.find((c) => c.name === "OnTarget_modest");
const prettyFar = composite.ranked.find((c) => c.name === "PrettyButFar_43pctOff");
console.log(
  `\nDoes the on-target route now beat the 43%-off "pretty" route? ${
    onTarget.compositeScore > prettyFar.compositeScore ? "YES" : "NO"
  } (OnTarget=${onTarget.compositeScore.toFixed(4)} vs PrettyButFar=${prettyFar.compositeScore.toFixed(4)})`
);

// Extra check: an even prettier off-target route (sweeps everything) still
// shouldn't beat a merely-decent on-target route.
console.log("\n--- Stress case: scenery-perfect but 60% off-target vs modest-but-on-target ---");
const stressBatch = [
  scoredCandidate("Modest_onTarget", 3218.68, 100, 10, 0),
  scoredCandidate("Spectacular_60pctOff", 5150, 1000, 200, 20),
];
stressBatch.forEach((c) =>
  console.log(`   ${c.name}: ${c.route.distanceMeters}m (${pct(c.route.distanceMeters)} off), trees=${c.treeScore.treeCount}, landmarks=${c.scenicScore.landmarkCount}, waterfront=${c.scenicScore.waterfrontCount}`)
);
const stress = rankByComposite(stressBatch, "greenery", TARGET);
stress.ranked.forEach((c, i) => console.log(`   ${i + 1}. ${c.name}: composite=${c.compositeScore.toFixed(4)}`));
console.log(`   Winner: ${stress.winner.name}`);
