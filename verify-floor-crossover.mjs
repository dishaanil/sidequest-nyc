import { rankByComposite } from "./src/lib/compositeScoring.js";

const METERS_PER_MILE = 1609.34;
const TARGET = 2 * METERS_PER_MILE;

function sc(name, distanceMeters, trees, landmarks, waterfront) {
  return {
    name,
    route: { distanceMeters },
    treeScore: { treeCount: trees, bufferMeters: 50 },
    scenicScore: { landmarkCount: landmarks, waterfrontCount: waterfront, total: landmarks + waterfront, bufferMeters: 75 },
  };
}

function run(label, batch) {
  console.log(`\n--- ${label} ---`);
  const r = rankByComposite(batch, "greenery", TARGET);
  r.ranked.forEach((c, i) =>
    console.log(
      `  ${i + 1}. ${c.name}: composite=${c.compositeScore.toFixed(4)} (sceneryScore=${c.sceneryScore.toFixed(3)}, distanceAccuracy=${c.normalized.distance.toFixed(3)})`
    )
  );
}

// A: floored on distance (60% off, essentially worst possible), max scenery in batch.
// B: floored on scenery (worst in batch), near-perfect distance.
// This is the extreme case -- asymmetric floors should make B win comfortably.
run("Extreme: A=scenery-max+distance-floored vs B=scenery-floored+distance-near-perfect", [
  sc("A_pretty_60pctOff", 5150, 500, 80, 5),
  sc("B_modest_onTarget", 3218.68, 50, 5, 0),
]);

// Crossover check: A still has max scenery + floored distance, but B's
// distance is now only moderately good (~28% off, near my calculated
// crossover), not near-perfect. Hand math predicted this is close to a tie.
run("Near crossover: A=scenery-max+distance-floored(60% off) vs B=scenery-floored+distance~28%-off", [
  sc("A_pretty_60pctOff", 5150, 500, 80, 5),
  sc("B_modest_28pctOff", 4130, 50, 5, 0), // (4130-3218.68)/3218.68 = 28.3%
]);

// Both floored on the SAME axis (both bad scenery) -- should rank purely by distance.
run("Both floored on scenery (bad scenery both) -- should rank by distance alone", [
  sc("C_onTarget_badScenery", 3218.68, 10, 1, 0),
  sc("D_5pctOff_badScenery", 3050, 12, 1, 0),
]);

// Both floored on distance (both ~50%+ off) -- should rank purely by scenery.
run("Both floored on distance (both way off) -- should rank by scenery alone", [
  sc("E_wayOff_goodScenery", 4900, 400, 60, 4),
  sc("F_wayOff_betterScenery", 5000, 450, 70, 5),
]);
