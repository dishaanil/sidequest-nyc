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
import { scoreRouteForTrees } from "@/lib/treeScoring";
import { scoreRouteForScenic } from "@/lib/scenicScoring";
import { findNearestStop } from "@/lib/stopFinder";
import { parseNaturalLanguageRequest } from "@/lib/nlParser";
import { rankByComposite } from "@/lib/compositeScoring";
import { mapWithConcurrency } from "@/lib/concurrency";

const METERS_PER_MILE = 1609.34;
const NL_SUPPORTED_STOP_TYPES = ["coffee", "library"]; // matches stopFinder.js's FINDERS keys

const STATUS_LABEL = {
  parsing: "Reading your request…",
  geocoding: "Finding your starting point…",
  resolvingWaypoint: "Finding a stop along the way…",
  generating: "Generating candidate routes…",
  scoring: "Scoring routes against NYC open data…",
};

const VARIANT_META = {
  greenest: { label: "Greenest", color: "#16a34a" },
  scenic: { label: "Most Scenic", color: "#a855f7" },
  efficient: { label: "Most Efficient", color: "#2563eb" },
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

/** One-sentence, data-grounded explanation for the composite-scored "Your Route" pick. */
function winnerExplanation(result) {
  const winner = result.composite.winner;
  const pref = result.preferenceEmphasis;

  let metricPhrase;
  if (pref === "greenery") {
    metricPhrase = `passes within ${winner.treeScore.bufferMeters}m of ${winner.treeScore.treeCount} trees`;
  } else if (pref === "landmarks") {
    metricPhrase = `passes within ${winner.scenicScore.bufferMeters}m of ${winner.scenicScore.landmarkCount} designated landmarks`;
  } else if (pref === "waterfront") {
    metricPhrase = `passes within ${winner.scenicScore.bufferMeters}m of ${winner.scenicScore.waterfrontCount} waterfront access points`;
  } else {
    metricPhrase = `passes within ${winner.treeScore.bufferMeters}m of ${winner.treeScore.treeCount} trees, ${winner.scenicScore.landmarkCount} landmarks, and ${winner.scenicScore.waterfrontCount} waterfront access points`;
  }

  const parts = [metricPhrase, describeStop(result), describeEnd(result)].filter(Boolean);
  let sentence = joinParts(parts);

  if (result.inputMode === "nl") {
    const stopKind = result.stopSource?.startsWith("stop_type:") ? result.stopSource.split(":")[1] : null;
    const reqPhrase = PREFERENCE_LABEL[pref] || "your requested route";
    sentence += `, per your request for ${reqPhrase}${stopKind ? ` with a ${stopKind} stop` : ""}`;
  }

  return sentence + ".";
}

const variantExplanation = (key, v, candidateCount) => {
  if (key === "greenest") {
    return `passes within ${v.treeScore.bufferMeters}m of ${v.treeScore.treeCount} trees, per the NYC 2015 Street Tree Census.`;
  }
  if (key === "scenic") {
    return `passes within ${v.scenicScore.bufferMeters}m of ${v.scenicScore.landmarkCount} designated landmarks and ${v.scenicScore.waterfrontCount} waterfront access points.`;
  }
  return `the shortest of the ${candidateCount} candidate routes generated for this trip, picked without regard to scenery.`;
};

/**
 * Shared pipeline: geocode start, resolve an optional distinct `end` (which
 * makes the route genuinely point-to-point instead of a loop) and an
 * independent required `stop` (e.g. a coffee shop, "on the way" in either
 * shape), generate candidates, score them, and compute both the existing
 * Greenest/Scenic/Efficient picks and the composite-ranked winner. Used by
 * both input modes so neither duplicates this orchestration.
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
      treeScore: await scoreRouteForTrees(c.route.coords),
      scenicScore: await scoreRouteForScenic(c.route.coords),
    }),
    250
  );

  const greenest = [...scored].sort((a, b) => b.treeScore.treeCount - a.treeScore.treeCount)[0];
  const scenic = [...scored].sort((a, b) => b.scenicScore.total - a.scenicScore.total)[0];
  const efficient = [...scored].sort((a, b) => a.route.distanceMeters - b.route.distanceMeters)[0];
  const composite = rankByComposite(scored, preferenceEmphasis, targetMeters);

  return {
    start,
    end,
    stop,
    stopSource,
    notes,
    candidateCount: candidates.length,
    candidates: scored,
    greenest,
    scenic,
    efficient,
    composite,
    preferenceEmphasis: composite.preferenceEmphasis,
  };
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

  const isLoading = ["parsing", "geocoding", "resolvingWaypoint", "generating", "scoring"].includes(genStatus);

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

      setResult({ ...pipelineResult, inputMode: "nl" });
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

      setResult({ ...pipelineResult, inputMode: "form" });
      setGenStatus("done");
    } catch (err) {
      console.error(err);
      setGenError(err.message || "Something went wrong generating your routes.");
      setGenStatus("error");
    }
  };

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

        {result && (
          <Card className="border-2 border-slate-900">
            <CardHeader>
              <CardTitle className="text-xl">Your Route</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg overflow-hidden border border-slate-200 h-[400px]">
                <MapContainer center={[result.start.lat, result.start.lng]} zoom={14} className="h-full w-full">
                  <TileLayer
                    attribution='&copy; OpenStreetMap contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <Polyline
                    positions={result.composite.winner.route.coords.map(([lng, lat]) => [lat, lng])}
                    pathOptions={{ color: "#0f172a", weight: 5 }}
                  />
                  <RouteMarkers result={result} />
                </MapContainer>
              </div>
              <p className="text-base text-slate-800">
                <strong>{(result.composite.winner.route.distanceMeters / METERS_PER_MILE).toFixed(2)} mi</strong>
                {" — "}
                {winnerExplanation(result)}
              </p>
            </CardContent>
          </Card>
        )}

        {result && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-slate-500">Other options to consider</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {VARIANT_ORDER.map((key) => {
                const v = result[key];
                const meta = VARIANT_META[key];
                return (
                  <Card key={key}>
                    <CardHeader>
                      <CardTitle className="text-base" style={{ color: meta.color }}>
                        {meta.label}
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
                        {variantExplanation(key, v, result.candidateCount)}
                      </p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {result && (
          <p className="text-xs text-slate-500">
            Tree data is a 2015–2016 snapshot from NYC Open Data, not a live feed. Landmark and
            waterfront-access data reflect current designations but may lag real-world changes
            slightly — actual conditions may differ.
          </p>
        )}
      </div>
    </div>
  );
}
