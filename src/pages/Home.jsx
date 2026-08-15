import { useState } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { geocodeAddress } from "@/lib/mapboxApi";
import { generateCandidateRoutes } from "@/lib/routeCandidates";
import { computeScoreBreakdown } from "@/lib/scoreBreakdown";
import { findNearestStop } from "@/lib/stopFinder";
import { parseNaturalLanguageRequest } from "@/lib/nlParser";
import { rankByComposite } from "@/lib/compositeScoring";
import { mapWithConcurrency } from "@/lib/concurrency";
import { explainRouteChoice } from "@/lib/explainRoute";
import { getVariantLabels } from "@/lib/variantLabels";
import { positionAlongRouteFraction } from "@/lib/geo";

const METERS_PER_MILE = 1609.34;
const NL_SUPPORTED_STOP_TYPES = ["coffee", "library"]; // matches stopFinder.js's FINDERS keys

const STATUS_LABEL = {
  parsing: "Reading your request…",
  geocoding: "Finding your starting point…",
  resolvingWaypoint: "Finding a stop along the way…",
  generating: "Generating candidate routes…",
  scoring: "Scoring routes against NYC open data…",
  explaining: "Explaining the choice…",
};

const VARIANT_META = {
  greenest: { color: "#16a34a", scoreKey: "greeneryScore" },
  scenic: { color: "#a855f7", scoreKey: "scenicScore" },
  efficient: { color: "#2563eb", scoreKey: "runningQualityScore" },
};
const VARIANT_ORDER = ["greenest", "scenic", "efficient"];

const PREFERENCE_LABEL = {
  greenery: "a green route",
  landmarks: "a landmark-heavy route",
  waterfront: "a waterfront route",
  balanced: "a balanced route",
};

/** Joins phrases as "A", "A and B", or "A, B, and C". */
function joinParts(parts) {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function describeStop(result) {
  if (!result.stop) return null;
  const name = result.stop.name || result.stop.placeName || "your requested stop";
  const kind = result.stopSource?.startsWith("stop_type:") ? result.stopSource.split(":")[1] : "stop";
  return `stops for ${kind} at ${name}`;
}

function describeEnd(result) {
  if (!result.end) return null;
  const name = result.end.name || result.end.placeName || "your requested end point";
  return `ends near ${name}`;
}

/** Short intro sentence mentioning the stop/end and (for NL requests) what was asked for. */
function introSentence(result) {
  const parts = [describeStop(result), describeEnd(result)].filter(Boolean);
  if (parts.length === 0) return null;
  let s = joinParts(parts);
  if (result.inputMode === "nl") {
    const pref = result.preferenceEmphasis;
    const stopKind = result.stopSource?.startsWith("stop_type:") ? result.stopSource.split(":")[1] : null;
    const reqPhrase = PREFERENCE_LABEL[pref] || "your requested route";
    s += `, per your request for ${reqPhrase}${stopKind ? ` with a ${stopKind} stop` : ""}`;
  }
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function greeneryEvidence(b) {
  return `calculated from ${b.evidence.treeCount} trees within ${b.evidence.treeBufferMeters}m (${b.evidence.treeDensityPer100m}/100m, vs a ${b.evidence.treeDensityReferencePer100m}/100m reference for a fully tree-lined block), ${b.evidence.parkExposurePct}% of route adjacent to park/green space.`;
}
function scenicEvidence(b) {
  return `0.35×waterfront (${b.evidence.waterfrontExposurePct}% exposure) + 0.25×park (${b.evidence.parkExposurePct}%) + 0.20×landmark (${b.evidence.landmarkExposurePct}%) + 0.20×tree density (${b.components.greeneryForScenic}/100).`;
}
function runningQualityEvidence(b, distanceMeters, targetMeters) {
  const mi = (distanceMeters / METERS_PER_MILE).toFixed(2);
  const targetMi = (targetMeters / METERS_PER_MILE).toFixed(2);
  return `${mi}mi actual vs ${targetMi}mi requested (${b.evidence.distanceDeviationPct}% off target).`;
}

/** Big number + label + one-line evidence, used for all three headline scores. */
function ScoreTile({ label, score, evidence, color }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-1.5">
        <span className="text-3xl font-bold" style={{ color }}>
          {score}
        </span>
        <span className="text-sm text-slate-500">/100</span>
      </div>
      <div className="text-xs font-medium text-slate-700">{label}</div>
      <p className="text-xs text-slate-500">{evidence}</p>
    </div>
  );
}

const variantExplanation = (key, v) => {
  if (key === "greenest") return greeneryEvidence(v.breakdown);
  if (key === "scenic") return scenicEvidence(v.breakdown);
  return null; // efficient uses runningQualityEvidence, which needs targetMeters from the caller
};

/**
 * Shared pipeline: geocode start, resolve an optional distinct `end` (which
 * makes the route genuinely point-to-point instead of a loop) and an
 * independent required `stop` (e.g. a coffee shop, "on the way" in either
 * shape), generate candidates, compute deterministic 0-100 score
 * breakdowns from real NYC Open Data geometry, and pick both the existing
 * Greenest/Scenic/Efficient variants and the composite-ranked winner. Used
 * by both input modes so neither duplicates this orchestration.
 */
async function runPipeline({ start: startQuery, end: endQuery, targetMeters, stopTypeRaw, preferenceEmphasis, setStatus }) {
  setStatus("geocoding");
  const start = await geocodeAddress(startQuery);

  const notes = [];

  let end = null;
  if (endQuery) {
    setStatus("resolvingWaypoint");
    try {
      end = await geocodeAddress(endQuery);
    } catch (err) {
      notes.push(`Couldn't geocode "${endQuery}" (${err.message}); looping back to start instead.`);
    }
  }

  let stop = null;
  let stopSource = null;
  if (stopTypeRaw) {
    const normalized = stopTypeRaw.toLowerCase().trim();
    if (NL_SUPPORTED_STOP_TYPES.includes(normalized)) {
      setStatus("resolvingWaypoint");
      stop = await findNearestStop(start, normalized);
      stopSource = stop ? `stop_type:${normalized}` : null;
      if (!stop) notes.push(`No ${normalized} found near the start point; continuing without a stop.`);
    } else if (normalized !== "none") {
      notes.push(`Stop type "${stopTypeRaw}" isn't supported yet (only coffee/library); continuing without a stop.`);
    }
  }

  setStatus("generating");
  const { candidates, feasibility } = await generateCandidateRoutes(start, targetMeters, stop, end);
  if (candidates.length === 0) {
    throw new Error("Couldn't generate any walking routes from that starting point.");
  }

  if (feasibility && (feasibility.reason || feasibility.tolerance === "max")) {
    const placeLabel = end ? end.name || end.placeName || endQuery : stop?.name || stop?.placeName || "the required stop";
    const targetMi = (targetMeters / METERS_PER_MILE).toFixed(2);
    const directMi = feasibility.directMeters != null ? (feasibility.directMeters / METERS_PER_MILE).toFixed(2) : null;
    const bestMi = feasibility.bestDistanceMeters != null ? (feasibility.bestDistanceMeters / METERS_PER_MILE).toFixed(2) : null;

    if (feasibility.reason === "too_far") {
      notes.push(
        `${startQuery} to ${placeLabel} is ${directMi}mi direct — longer than the ${targetMi}mi you asked for, so here's the most direct route between them instead.`
      );
    } else if (feasibility.reason === "detour_added" && feasibility.feasible) {
      notes.push(
        `${startQuery} to ${placeLabel} is only ${directMi}mi direct, so I added a detour to bring this route to ${bestMi}mi, within your ${targetMi}mi target.`
      );
    } else if (feasibility.reason === "detour_insufficient") {
      notes.push(
        `${startQuery} to ${placeLabel} is only ${directMi}mi direct — even with a detour, the closest I could get was ${bestMi}mi, outside the ±10% range around your ${targetMi}mi target.`
      );
    } else if (feasibility.reason === "off_target") {
      notes.push(
        directMi != null
          ? `${startQuery} to ${placeLabel} is ${directMi}mi direct — I couldn't hit ${targetMi}mi ±10% through it, so here's the closest reasonable route (${bestMi}mi) instead.`
          : `Couldn't generate a loop within 10% of your requested ${targetMi}mi from ${startQuery}; showing the closest available (${bestMi}mi) instead.`
      );
    } else if (!feasibility.reason && feasibility.tolerance === "max") {
      notes.push(`Closest match was within 10% of your ${targetMi}mi target — couldn't find one within the preferred 5%.`);
    }
  }

  setStatus("scoring");
  const scored = await mapWithConcurrency(
    candidates,
    2,
    async (c) => ({
      ...c,
      breakdown: await computeScoreBreakdown(c.route.coords, c.route.distanceMeters, targetMeters),
    }),
    250
  );

  const greenest = [...scored].sort((a, b) => b.breakdown.greeneryScore - a.breakdown.greeneryScore)[0];
  const scenic = [...scored].sort((a, b) => b.breakdown.scenicScore - a.breakdown.scenicScore)[0];
  const efficient = [...scored].sort((a, b) => a.route.distanceMeters - b.route.distanceMeters)[0];
  const composite = rankByComposite(scored, preferenceEmphasis);

  return {
    start,
    end,
    stop,
    stopSource,
    notes,
    targetMeters,
    candidateCount: candidates.length,
    candidates: scored,
    greenest,
    scenic,
    efficient,
    composite,
    preferenceEmphasis: composite.preferenceEmphasis,
  };
}

/**
 * Pure, deterministic comparison numbers — no LLM involved here. This is the
 * "data first" half of the explanation: everything the LLM is later allowed
 * to talk about, and nothing it isn't.
 */
function buildComparisonStats(result) {
  const winner = result.composite.winner;
  const stats = {
    preference_emphasis: result.preferenceEmphasis,
    target_distance_mi: Number((result.targetMeters / METERS_PER_MILE).toFixed(2)),
    winner_distance_mi: Number((winner.route.distanceMeters / METERS_PER_MILE).toFixed(2)),
    winner_distance_deviation_pct: winner.breakdown.evidence.distanceDeviationPct,
    winner_greenery_score: winner.breakdown.greeneryScore,
    winner_scenic_score: winner.breakdown.scenicScore,
    winner_running_quality_score: winner.breakdown.runningQualityScore,
    shortest_option_distance_mi: Number((result.efficient.route.distanceMeters / METERS_PER_MILE).toFixed(2)),
    shortest_option_greenery_score: result.efficient.breakdown.greeneryScore,
    greenery_score_improvement_vs_shortest_option: winner.breakdown.greeneryScore - result.efficient.breakdown.greeneryScore,
    greenest_alternative_greenery_score: result.greenest.breakdown.greeneryScore,
    scenic_alternative_scenic_score: result.scenic.breakdown.scenicScore,
  };

  if (result.stop) {
    stats.stop_type = result.stopSource?.startsWith("stop_type:") ? result.stopSource.split(":")[1] : "stop";
    stats.stop_name = result.stop.name || result.stop.placeName || null;
    stats.stop_position_pct_along_route = Math.round(
      positionAlongRouteFraction(result.stop.lat, result.stop.lng, winner.route.coords) * 100
    );
  }

  return stats;
}

/** Start/stop/end markers shared by the hero card and each variant card. */
function RouteMarkers({ result }) {
  return (
    <>
      <CircleMarker
        center={[result.start.lat, result.start.lng]}
        radius={8}
        pathOptions={{ color: "#1d4ed8", fillColor: "#1d4ed8", fillOpacity: 1 }}
      >
        <Popup>{result.end ? "Start" : "Start / End"}</Popup>
      </CircleMarker>
      {result.end && (
        <CircleMarker
          center={[result.end.lat, result.end.lng]}
          radius={8}
          pathOptions={{ color: "#dc2626", fillColor: "#dc2626", fillOpacity: 1 }}
        >
          <Popup>{result.end.name || result.end.placeName || "End"}</Popup>
        </CircleMarker>
      )}
      {result.stop && (
        <CircleMarker
          center={[result.stop.lat, result.stop.lng]}
          radius={8}
          pathOptions={{ color: "#d97706", fillColor: "#d97706", fillOpacity: 1 }}
        >
          <Popup>{result.stop.name || result.stop.placeName}</Popup>
        </CircleMarker>
      )}
    </>
  );
}

export default function Home() {
  const [inputMode, setInputMode] = useState("nl"); // nl | form

  // Natural-language input (primary)
  const [nlText, setNlText] = useState("");
  const [nlParsed, setNlParsed] = useState(null);

  // Form input (fallback)
  const [address, setAddress] = useState("");
  const [distanceMiles, setDistanceMiles] = useState("2");
  const [stopType, setStopType] = useState("none");

  // Shared generation state
  const [genStatus, setGenStatus] = useState("idle");
  const [genError, setGenError] = useState(null);
  const [result, setResult] = useState(null);

  const isLoading = ["parsing", "geocoding", "resolvingWaypoint", "generating", "scoring", "explaining"].includes(genStatus);

  const handleGenerateNL = async (e) => {
    e.preventDefault();
    setGenError(null);
    setResult(null);
    setNlParsed(null);

    if (!nlText.trim()) {
      setGenError("Describe your run first.");
      return;
    }

    try {
      setGenStatus("parsing");
      const parsed = await parseNaturalLanguageRequest(nlText);
      setNlParsed(parsed);

      const targetMeters = (parsed.distance_miles || 0) * METERS_PER_MILE;
      if (!parsed.start || !targetMeters || targetMeters <= 0) {
        throw new Error(
          'Couldn\'t find a clear starting point and distance in that description — try being more specific (e.g. "Start at Union Square, run 2 miles...").'
        );
      }

      const pipelineResult = await runPipeline({
        start: parsed.start,
        end: parsed.end,
        targetMeters,
        stopTypeRaw: parsed.stop_type,
        preferenceEmphasis: parsed.preference_emphasis,
        setStatus: setGenStatus,
      });

      const withMode = { ...pipelineResult, inputMode: "nl" };
      setGenStatus("explaining");
      let whyExplanation = null;
      try {
        whyExplanation = await explainRouteChoice(buildComparisonStats(withMode));
      } catch (explainErr) {
        console.error("explainRouteChoice failed:", explainErr);
      }

      setResult({ ...withMode, whyExplanation });
      setGenStatus("done");
    } catch (err) {
      console.error(err);
      setGenError(err.message || "Something went wrong generating your route.");
      setGenStatus("error");
    }
  };

  const handleGenerateForm = async (e) => {
    e.preventDefault();
    setGenError(null);
    setResult(null);
    setNlParsed(null);

    const targetMeters = parseFloat(distanceMiles) * METERS_PER_MILE;
    if (!address.trim() || !targetMeters || targetMeters <= 0) {
      setGenError("Enter a starting point and a distance greater than 0.");
      return;
    }

    try {
      const pipelineResult = await runPipeline({
        start: address,
        end: null,
        targetMeters,
        stopTypeRaw: stopType === "none" ? null : stopType,
        preferenceEmphasis: "balanced",
        setStatus: setGenStatus,
      });

      const withMode = { ...pipelineResult, inputMode: "form" };
      setGenStatus("explaining");
      let whyExplanation = null;
      try {
        whyExplanation = await explainRouteChoice(buildComparisonStats(withMode));
      } catch (explainErr) {
        console.error("explainRouteChoice failed:", explainErr);
      }

      setResult({ ...withMode, whyExplanation });
      setGenStatus("done");
    } catch (err) {
      console.error(err);
      setGenError(err.message || "Something went wrong generating your routes.");
      setGenStatus("error");
    }
  };

  const winner = result?.composite.winner;

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Sidequest</h1>
          <p className="text-slate-600 text-sm">
            Generate a running route scored against real NYC open data.
          </p>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={inputMode === "nl" ? "default" : "outline"}
                onClick={() => setInputMode("nl")}
              >
                Describe your run
              </Button>
              <Button
                type="button"
                size="sm"
                variant={inputMode === "form" ? "default" : "outline"}
                onClick={() => setInputMode("form")}
              >
                Use the form
              </Button>
            </div>

            {inputMode === "nl" ? (
              <form onSubmit={handleGenerateNL} className="space-y-3">
                <Textarea
                  placeholder={
                    'e.g. "I’m starting at Union Square, ending at Washington Square, run 2 miles, stop at a coffee shop on the way, and I want my route to be as green as possible."'
                  }
                  value={nlText}
                  onChange={(e) => setNlText(e.target.value)}
                  rows={3}
                />
                <Button type="submit" disabled={isLoading}>
                  {isLoading ? STATUS_LABEL[genStatus] : "Generate route"}
                </Button>
                {nlParsed && (
                  <p className="text-xs text-slate-500">
                    Understood: start "{nlParsed.start}"
                    {nlParsed.end ? `, end "${nlParsed.end}"` : ", loop back to start"}
                    {`, ${nlParsed.distance_miles} mi`}
                    {nlParsed.stop_type ? `, ${nlParsed.stop_type} stop` : ", no stop"}
                    {`, ${nlParsed.preference_emphasis} preference`}.
                  </p>
                )}
              </form>
            ) : (
              <form onSubmit={handleGenerateForm} className="flex flex-wrap items-end gap-4">
                <div className="flex-1 min-w-[220px] space-y-1.5">
                  <Label htmlFor="address">Starting point</Label>
                  <Input
                    id="address"
                    placeholder="e.g. Union Square, NYC"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                </div>
                <div className="w-32 space-y-1.5">
                  <Label htmlFor="distance">Distance (mi)</Label>
                  <Input
                    id="distance"
                    type="number"
                    min="0.5"
                    step="0.5"
                    value={distanceMiles}
                    onChange={(e) => setDistanceMiles(e.target.value)}
                  />
                </div>
                <div className="w-44 space-y-1.5">
                  <Label htmlFor="stop">Sidequest stop</Label>
                  <Select value={stopType} onValueChange={setStopType}>
                    <SelectTrigger id="stop">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="coffee">Coffee ☕</SelectItem>
                      <SelectItem value="library">Library 📚</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" disabled={isLoading}>
                  {isLoading ? STATUS_LABEL[genStatus] : "Generate routes"}
                </Button>
              </form>
            )}

            {genError && <p className="text-sm text-red-600">{genError}</p>}
            {result?.notes.map((n, i) => (
              <p key={i} className="text-xs text-amber-600">
                {n}
              </p>
            ))}
          </CardContent>
        </Card>

        {result && winner && (
          <Card className="border-2 border-slate-900">
            <CardHeader>
              <CardTitle className="text-xl">Best Match</CardTitle>
              <p className="text-sm text-slate-600">
                <strong>{(winner.route.distanceMeters / METERS_PER_MILE).toFixed(2)} mi</strong>
                {introSentence(result) ? ` — ${introSentence(result)}` : "."}
              </p>
              {result.whyExplanation && (
                <p className="text-sm text-slate-700 bg-slate-50 rounded-md px-3 py-2 mt-2">
                  <strong>Why Sidequest chose this: </strong>
                  {result.whyExplanation}
                </p>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg overflow-hidden border border-slate-200 h-[400px]">
                <MapContainer center={[result.start.lat, result.start.lng]} zoom={14} className="h-full w-full">
                  <TileLayer
                    attribution='&copy; OpenStreetMap contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <Polyline
                    positions={winner.route.coords.map(([lng, lat]) => [lat, lng])}
                    pathOptions={{ color: "#0f172a", weight: 5 }}
                  />
                  <RouteMarkers result={result} />
                </MapContainer>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-slate-100">
                <ScoreTile
                  label="Greenery"
                  score={winner.breakdown.greeneryScore}
                  evidence={greeneryEvidence(winner.breakdown)}
                  color="#16a34a"
                />
                <ScoreTile
                  label="Scenic"
                  score={winner.breakdown.scenicScore}
                  evidence={scenicEvidence(winner.breakdown)}
                  color="#a855f7"
                />
                <ScoreTile
                  label="Running Quality"
                  score={winner.breakdown.runningQualityScore}
                  evidence={runningQualityEvidence(winner.breakdown, winner.route.distanceMeters, result.targetMeters)}
                  color="#2563eb"
                />
              </div>
            </CardContent>
          </Card>
        )}

        {result && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-slate-500">Other options to consider</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {(() => {
                const stopKindForLabel = result.stopSource?.startsWith("stop_type:") ? result.stopSource.split(":")[1] : null;
                const labels = getVariantLabels(result.preferenceEmphasis, stopKindForLabel);
                return VARIANT_ORDER.map((key) => {
                  const v = result[key];
                  const meta = VARIANT_META[key];
                  const label = labels[key];
                  const score = v.breakdown[meta.scoreKey];
                  const evidence =
                    key === "efficient"
                      ? runningQualityEvidence(v.breakdown, v.route.distanceMeters, result.targetMeters)
                      : variantExplanation(key, v);
                  return (
                    <Card key={key}>
                      <CardHeader>
                        <CardTitle className="text-base" style={{ color: meta.color }}>
                          {label}
                        </CardTitle>
                      </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="rounded-lg overflow-hidden border border-slate-200 h-[220px]">
                        <MapContainer center={[result.start.lat, result.start.lng]} zoom={14} className="h-full w-full">
                          <TileLayer
                            attribution='&copy; OpenStreetMap contributors'
                            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                          />
                          <Polyline
                            positions={v.route.coords.map(([lng, lat]) => [lat, lng])}
                            pathOptions={{ color: meta.color, weight: 4 }}
                          />
                          <RouteMarkers result={result} />
                        </MapContainer>
                      </div>
                      <p className="text-sm text-slate-700">
                        <strong>{(v.route.distanceMeters / METERS_PER_MILE).toFixed(2)} mi</strong>
                        {" — "}
                        <strong style={{ color: meta.color }}>{score}/100</strong> score
                      </p>
                      <p className="text-xs text-slate-500">{evidence}</p>
                    </CardContent>
                  </Card>
                  );
                });
              })()}
            </div>
          </div>
        )}

        {result && (
          <p className="text-xs text-slate-500">
            Tree data is a 2015–2016 snapshot from NYC Open Data, not a live feed. Landmark, park, and
            waterfront-access data reflect current designations but may lag real-world changes
            slightly — actual conditions may differ.
          </p>
        )}
      </div>
    </div>
  );
}
