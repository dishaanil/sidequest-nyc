import { filterByTolerance, dedupeCandidates } from "./src/lib/routeCandidates.js";
import { rankByComposite } from "./src/lib/compositeScoring.js";

const METERS_PER_MILE = 1609.34;
const TARGET = 2 * METERS_PER_MILE; // 3218.68m

function pct(dev) {
  return (dev * 100).toFixed(1) + "%";
}
function dev(d) {
  return Math.abs(d - TARGET) / TARGET;
}

console.log("=================================================================");
console.log("TEST 1: filterByTolerance — widening from +/-5% to +/-10%");
console.log("=================================================================");
console.log(`target = ${TARGET.toFixed(1)}m (2.00mi)\n`);

// --- 1a: nothing within 5%, several within 10% -> should widen ---
const batch1a = [
  { name: "c1_11.9pct_over", route: { distanceMeters: 3600 } },
  { name: "c2_7.2pct_over", route: { distanceMeters: 3450 } },
  { name: "c3_8.8pct_over", route: { distanceMeters: 3500 } },
  { name: "c4_9.9pct_under", route: { distanceMeters: 2900 } },
  { name: "c5_5.2pct_under", route: { distanceMeters: 3050 } },
];
console.log("1a) Batch where NOTHING is within +/-5%, several within +/-10%:");
batch1a.forEach((c) => console.log(`   ${c.name}: ${c.route.distanceMeters}m (${pct(dev(c.route.distanceMeters))} off)`));
const result1a = filterByTolerance(batch1a, TARGET);
console.log(`   -> tolerance tier used: "${result1a.tolerance}"`);
console.log(`   -> candidates kept: [${result1a.candidates.map((c) => c.name).join(", ")}]`);
console.log(`   -> EXPECTED: tolerance="max", c1 (11.9%) excluded, the other 4 kept\n`);

// --- 1b: something within 5% present -> should NOT widen ---
const batch1b = [
  { name: "c1_0pct", route: { distanceMeters: 3218.68 } },
  { name: "c2_11.9pct_over", route: { distanceMeters: 3600 } },
  { name: "c3_3.7pct_under", route: { distanceMeters: 3100 } },
];
console.log("1b) Batch where something IS within +/-5%:");
batch1b.forEach((c) => console.log(`   ${c.name}: ${c.route.distanceMeters}m (${pct(dev(c.route.distanceMeters))} off)`));
const result1b = filterByTolerance(batch1b, TARGET);
console.log(`   -> tolerance tier used: "${result1b.tolerance}"`);
console.log(`   -> candidates kept: [${result1b.candidates.map((c) => c.name).join(", ")}]`);
console.log(`   -> EXPECTED: tolerance="preferred", only c1 and c3 kept, c2 excluded\n`);

// --- 1c: nothing within even 10% -> tolerance="none", everything passed through ---
const batch1c = [
  { name: "c1_50pct_over", route: { distanceMeters: 4828 } },
  { name: "c2_60pct_over", route: { distanceMeters: 5150 } },
];
console.log("1c) Batch where NOTHING is within +/-10% (genuinely infeasible):");
batch1c.forEach((c) => console.log(`   ${c.name}: ${c.route.distanceMeters}m (${pct(dev(c.route.distanceMeters))} off)`));
const result1c = filterByTolerance(batch1c, TARGET);
console.log(`   -> tolerance tier used: "${result1c.tolerance}"`);
console.log(`   -> candidates kept: [${result1c.candidates.map((c) => c.name).join(", ")}]`);
console.log(`   -> EXPECTED: tolerance="none", both passed through unfiltered (caller flags infeasible)\n`);

console.log("=================================================================");
console.log("TEST 2: dedupeCandidates — geometry-based near-duplicate detection");
console.log("=================================================================\n");

// Route X: small rectangle loop near Union Square
const routeX = [
  [-73.9905, 40.7359],
  [-73.9895, 40.7359],
  [-73.9895, 40.7368],
  [-73.9905, 40.7368],
  [-73.9905, 40.7359],
];
// Route Y: same shape, shifted ~11m lat / ~8.5m lng -- should read as a near-duplicate of X
const routeY = [
  [-73.9904, 40.736],
  [-73.9894, 40.736],
  [-73.9894, 40.7369],
  [-73.9904, 40.7369],
  [-73.9904, 40.736],
];
// Route Z: shifted ~1.1km away -- clearly distinct
const routeZ = [
  [-73.9805, 40.7259],
  [-73.9795, 40.7259],
  [-73.9795, 40.7268],
  [-73.9805, 40.7268],
  [-73.9805, 40.7259],
];
// Route W: shares its first two points with X, then diverges sharply -- partial overlap, should stay distinct
const routeW = [
  [-73.9905, 40.7359],
  [-73.9895, 40.7359],
  [-73.988, 40.738],
  [-73.986, 40.739],
];

const dedupInput = [
  { name: "X_original", bearing: 20, route: { coords: routeX, distanceMeters: 3250 } },
  { name: "Y_near_dup_of_X_11m_shift", bearing: 65, route: { coords: routeY, distanceMeters: 3260 } },
  { name: "Z_distinct_1.1km_away", bearing: 110, route: { coords: routeZ, distanceMeters: 3240 } },
  { name: "W_partial_overlap_with_X", bearing: 155, route: { coords: routeW, distanceMeters: 3200 } },
];
console.log("Input candidates:");
dedupInput.forEach((c) => console.log(`   ${c.name}`));
const deduped = dedupeCandidates(dedupInput);
console.log(`\n-> kept: [${deduped.map((c) => c.name).join(", ")}]`);
console.log(`-> EXPECTED: Y dropped (near-duplicate of X), X/Z/W kept (genuinely distinct)\n`);

console.log("=================================================================");
console.log("TEST 3: rankByComposite — does distance deviation act as a real penalty?");
console.log("=================================================================\n");

function scoredCandidate(name, distanceMeters, treeCount, landmarkCount, waterfrontCount) {
  return {
    name,
    route: { distanceMeters },
    treeScore: { treeCount, bufferMeters: 50 },
    scenicScore: { landmarkCount, waterfrontCount, total: landmarkCount + waterfrontCount, bufferMeters: 75 },
  };
}

const compositeBatch = [
  scoredCandidate("OnTarget_modest", 3218.68, 280, 35, 1), // 0% dev
  scoredCandidate("SlightlyOff_good", 3050, 320, 45, 2), // 5.2% dev
  scoredCandidate("PrettyButFar_43pctOff", 4600, 550, 90, 8), // 43.0% dev -- beyond max tolerance
  scoredCandidate("Modest_onTarget", 3300, 150, 15, 0), // 2.5% dev
  scoredCandidate("Middling", 3400, 250, 40, 3), // 5.7% dev
];

console.log("Input candidates (preference = 'greenery'):");
compositeBatch.forEach((c) =>
  console.log(
    `   ${c.name}: ${c.route.distanceMeters}m (${pct(dev(c.route.distanceMeters))} off), trees=${c.treeScore.treeCount}, landmarks=${c.scenicScore.landmarkCount}, waterfront=${c.scenicScore.waterfrontCount}`
  )
);

const composite = rankByComposite(compositeBatch, "greenery", TARGET);
console.log(`\nWeights used: trees=${composite.weights.trees.toFixed(3)}, landmarks=${composite.weights.landmarks.toFixed(3)}, waterfront=${composite.weights.waterfront.toFixed(3)}, distance=${composite.weights.distance.toFixed(3)}\n`);
console.log("Ranked (best first):");
composite.ranked.forEach((c, i) => {
  console.log(
    `   ${i + 1}. ${c.name}: composite=${c.compositeScore.toFixed(4)}  (normalized: trees=${c.normalized.trees.toFixed(2)}, landmarks=${c.normalized.landmarks.toFixed(2)}, waterfront=${c.normalized.waterfront.toFixed(2)}, distance=${c.normalized.distance.toFixed(2)})`
  );
});
console.log(`\nWinner: ${composite.winner.name}`);
const onTargetRanked = composite.ranked.find((c) => c.name === "OnTarget_modest");
const prettyFarRanked = composite.ranked.find((c) => c.name === "PrettyButFar_43pctOff");
console.log(
  `\nDid the on-target route beat the 43%-off "pretty" route? ${
    onTargetRanked.compositeScore > prettyFarRanked.compositeScore ? "YES" : "NO"
  } (OnTarget=${onTargetRanked.compositeScore.toFixed(4)} vs PrettyButFar=${prettyFarRanked.compositeScore.toFixed(4)})`
);
