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

const METERS_PER_MILE = 1609.34;
const CANDIDATE_COUNT = 4;

const STATUS_LABEL = {
  geocoding: "Finding your starting point…",
  findingStop: "Finding a stop along the way…",
  generating: "Generating candidate routes…",
  scoring: "Scoring routes against NYC open data…",
};

const VARIANT_META = {
  greenest: { label: "Greenest", color: "#16a34a" },
  scenic: { label: "Most Scenic", color: "#a855f7" },
  efficient: { label: "Most Efficient", color: "#2563eb" },
};
const VARIANT_ORDER = ["greenest", "scenic", "efficient"];

export default function Home() {
  const [address, setAddress] = useState("");
  const [distanceMiles, setDistanceMiles] = useState("2");
  const [stopType, setStopType] = useState("none");
  const [status, setStatus] = useState("idle"); // idle | geocoding | findingStop | generating | scoring | done | error
  const [error, setError] = useState(null);
  const [variants, setVariants] = useState(null); // { start, stop, candidateCount, greenest, scenic, efficient }

  // --- Natural-language parsing (debug/verification step, not wired into generation yet) ---
  const [nlText, setNlText] = useState("");
  const [nlStatus, setNlStatus] = useState("idle"); // idle | parsing | done | error
  const [nlError, setNlError] = useState(null);
  const [nlParsed, setNlParsed] = useState(null);

  const handleParseNaturalLanguage = async () => {
    setNlError(null);
    setNlParsed(null);
    if (!nlText.trim()) {
      setNlError("Type a description first.");
      return;
    }
    setNlStatus("parsing");
    try {
      const parsed = await parseNaturalLanguageRequest(nlText);
      setNlParsed(parsed);
      setNlStatus("done");
    } catch (err) {
      console.error(err);
      setNlError(err.message || "Couldn't parse that description.");
      setNlStatus("error");
    }
  };

  // --- Wire parsed NL output into the existing candidate generation/scoring
  // pipeline, unmodified, and show raw per-candidate scores (no composite
  // ranking yet — that's the next step). ---
  const NL_SUPPORTED_STOP_TYPES = ["coffee", "library"]; // matches stopFinder.js's FINDERS keys
  const [nlWireStatus, setNlWireStatus] = useState("idle"); // idle | geocoding | resolvingWaypoint | generating | scoring | done | error
  const [nlWireError, setNlWireError] = useState(null);
  const [nlScored, setNlScored] = useState(null); // { start, waypoint, waypointSource, notes, candidates }

  const nlWireBusy = ["geocoding", "resolvingWaypoint", "generating", "scoring"].includes(nlWireStatus);

  const handleGenerateFromParsed = async () => {
    setNlWireError(null);
    setNlScored(null);

    if (!nlParsed) {
      setNlWireError("Parse a description first.");
      return;
    }
    const targetMeters = (nlParsed.distance_miles || 0) * METERS_PER_MILE;
    if (!nlParsed.start || !targetMeters || targetMeters <= 0) {
      setNlWireError("Parsed result is missing a start location or a usable distance.");
      return;
    }

    const notes = [];
    try {
      setNlWireStatus("geocoding");
      const start = await geocodeAddress(nlParsed.start);

      // Reuses the exact same "required waypoint" mechanism generateCandidateRoutes
      // already supports for Tier 1 stops — a parsed `end` just takes priority
      // over a parsed `stop_type` as the thing fed into that same slot. The
      // route still loops back to start (unchanged from the existing
      // generator); it doesn't literally terminate at `end`.
      let waypoint = null;
      let waypointSource = null;

      if (nlParsed.end) {
        setNlWireStatus("resolvingWaypoint");
        try {
          waypoint = await geocodeAddress(nlParsed.end);
          waypointSource = `end: "${nlParsed.end}"`;
        } catch (err) {
          notes.push(`Couldn't geocode parsed end "${nlParsed.end}" (${err.message}); continuing without it.`);
        }
      }

      if (!waypoint && nlParsed.stop_type) {
        const normalized = nlParsed.stop_type.toLowerCase().trim();
        if (NL_SUPPORTED_STOP_TYPES.includes(normalized)) {
          setNlWireStatus("resolvingWaypoint");
          waypoint = await findNearestStop(start, normalized);
          if (waypoint) {
            waypointSource = `stop_type: "${normalized}"`;
          } else {
            notes.push(`No ${normalized} found near the start point; continuing without a stop.`);
          }
        } else {
          notes.push(
            `stop_type "${nlParsed.stop_type}" isn't a supported stop type yet (only coffee/library); continuing without a stop.`
          );
        }
      }

      setNlWireStatus("generating");
      const candidates = await generateCandidateRoutes(start, targetMeters, CANDIDATE_COUNT, waypoint);
      if (candidates.length === 0) {
        throw new Error("Couldn't generate any walking routes from the parsed starting point.");
      }

      setNlWireStatus("scoring");
      const scored = await Promise.all(
        candidates.map(async (c) => ({
          ...c,
          treeScore: await scoreRouteForTrees(c.route.coords),
          scenicScore: await scoreRouteForScenic(c.route.coords),
        }))
      );

      // Same selection logic as the main form's Greenest/Scenic/Efficient
      // variants (kept, not replaced) — plus the new composite ranking on top.
      const greenest = [...scored].sort((a, b) => b.treeScore.treeCount - a.treeScore.treeCount)[0];
      const scenic = [...scored].sort((a, b) => b.scenicScore.total - a.scenicScore.total)[0];
      const efficient = [...scored].sort((a, b) => a.route.distanceMeters - b.route.distanceMeters)[0];
      const composite = rankByComposite(scored, nlParsed.preference_emphasis);

      setNlScored({
        start,
        waypoint,
        waypointSource,
        notes,
        candidates: scored,
        greenest,
        scenic,
        efficient,
        composite,
      });
      setNlWireStatus("done");
    } catch (err) {
      console.error(err);
      setNlWireError(err.message || "Something went wrong generating candidates from the parsed request.");
      setNlWireStatus("error");
    }
  };

  const isLoading =
    status === "geocoding" ||
    status === "findingStop" ||
    status === "generating" ||
    status === "scoring";

  const handleGenerate = async (e) => {
    e.preventDefault();
    setError(null);
    setVariants(null);

    const targetMeters = parseFloat(distanceMiles) * METERS_PER_MILE;
    if (!address.trim() || !targetMeters || targetMeters <= 0) {
      setError("Enter a starting point and a distance greater than 0.");
      return;
    }

    try {
      setStatus("geocoding");
      const start = await geocodeAddress(address);

      let stop = null;
      if (stopType !== "none") {
        setStatus("findingStop");
        stop = await findNearestStop(start, stopType);
      }

      setStatus("generating");
      const candidates = await generateCandidateRoutes(start, targetMeters, CANDIDATE_COUNT, stop);
      if (candidates.length === 0) {
        throw new Error("Couldn't generate any walking routes from that starting point.");
      }

      setStatus("scoring");
      const scored = await Promise.all(
        candidates.map(async (c) => ({
          ...c,
          treeScore: await scoreRouteForTrees(c.route.coords),
          scenicScore: await scoreRouteForScenic(c.route.coords),
        }))
      );

      const greenest = [...scored].sort((a, b) => b.treeScore.treeCount - a.treeScore.treeCount)[0];
      const scenic = [...scored].sort((a, b) => b.scenicScore.total - a.scenicScore.total)[0];
      const efficient = [...scored].sort((a, b) => a.route.distanceMeters - b.route.distanceMeters)[0];

      setVariants({ start, stop, candidateCount: candidates.length, greenest, scenic, efficient });
      setStatus("done");
    } catch (err) {
      console.error(err);
      setError(err.message || "Something went wrong generating your routes.");
      setStatus("error");
    }
  };

  const variantExplanation = (key, v) => {
    if (key === "greenest") {
      return `passes within ${v.treeScore.bufferMeters}m of ${v.treeScore.treeCount} trees, per the NYC 2015 Street Tree Census.`;
    }
    if (key === "scenic") {
      return `passes within ${v.scenicScore.bufferMeters}m of ${v.scenicScore.landmarkCount} designated landmarks and ${v.scenicScore.waterfrontCount} waterfront access points.`;
    }
    return `the shortest of the ${variants.candidateCount} candidate routes generated for this trip, picked without regard to scenery.`;
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Sidequest</h1>
          <p className="text-slate-600 text-sm">
            Generate three route options, each scored against real NYC open data.
          </p>
        </div>

        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleGenerate} className="flex flex-wrap items-end gap-4">
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
                {isLoading ? STATUS_LABEL[status] : "Generate routes"}
              </Button>
            </form>
            {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
            {variants && stopType !== "none" && !variants.stop && (
              <p className="text-xs text-amber-600 mt-3">
                No {stopType} found within about 1.25mi of your starting point, so these routes
                don't include a stop.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Try describing your run in plain English (beta)</CardTitle>
            <p className="text-xs text-slate-500">
              Debug view — this parses your text and shows the structured result below. It doesn't
              generate a route yet; use the form above for that.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              placeholder={
                'e.g. "I’m starting at Union Square, ending at Washington Square, run 2 miles, stop at a coffee shop on the way, and I want my route to be as green as possible."'
              }
              value={nlText}
              onChange={(e) => setNlText(e.target.value)}
              rows={3}
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleParseNaturalLanguage}
              disabled={nlStatus === "parsing"}
            >
              {nlStatus === "parsing" ? "Parsing…" : "Parse"}
            </Button>
            {nlError && <p className="text-sm text-red-600">{nlError}</p>}
            {nlParsed && (
              <pre className="text-xs bg-slate-100 rounded-md p-3 overflow-x-auto">
                {JSON.stringify(nlParsed, null, 2)}
              </pre>
            )}

            {nlParsed && (
              <div className="pt-3 border-t border-slate-200 space-y-3">
                <Button type="button" variant="outline" onClick={handleGenerateFromParsed} disabled={nlWireBusy}>
                  {nlWireBusy ? "Generating candidates…" : "Generate & score candidates from this"}
                </Button>
                {nlWireError && <p className="text-sm text-red-600">{nlWireError}</p>}
                {nlScored && (
                  <div className="space-y-2">
                    <p className="text-xs text-slate-600">
                      Start: <strong>{nlScored.start.placeName || nlParsed.start}</strong>
                      {nlScored.waypoint && (
                        <>
                          {" "}
                          — required waypoint: <strong>{nlScored.waypoint.name || nlScored.waypoint.placeName}</strong>{" "}
                          (from {nlScored.waypointSource})
                        </>
                      )}
                    </p>
                    {nlScored.notes.map((n, i) => (
                      <p key={i} className="text-xs text-amber-600">
                        {n}
                      </p>
                    ))}
                    <p className="text-xs text-slate-600">
                      preference_emphasis: <strong>{nlScored.composite.preferenceEmphasis}</strong> — weights used:
                      trees {nlScored.composite.weights.trees.toFixed(2)}, landmarks{" "}
                      {nlScored.composite.weights.landmarks.toFixed(2)}, waterfront{" "}
                      {nlScored.composite.weights.waterfront.toFixed(2)}
                    </p>
                    <div className="overflow-x-auto">
                      <table className="text-xs w-full border-collapse">
                        <thead>
                          <tr className="text-left border-b border-slate-300">
                            <th className="py-1 pr-3">#</th>
                            <th className="py-1 pr-3">Bearing</th>
                            <th className="py-1 pr-3">Distance (mi)</th>
                            <th className="py-1 pr-3">
                              Trees (≤{nlScored.candidates[0]?.treeScore.bufferMeters}m)
                            </th>
                            <th className="py-1 pr-3">
                              Landmarks (≤{nlScored.candidates[0]?.scenicScore.bufferMeters}m)
                            </th>
                            <th className="py-1 pr-3">
                              Waterfront (≤{nlScored.candidates[0]?.scenicScore.bufferMeters}m)
                            </th>
                            <th className="py-1 pr-3">Composite</th>
                            <th className="py-1 pr-3">Picks</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nlScored.candidates.map((c, i) => {
                            const ranked = nlScored.composite.ranked.find((r) => r.bearing === c.bearing);
                            const picks = [];
                            if (c.bearing === nlScored.greenest.bearing) picks.push("Greenest");
                            if (c.bearing === nlScored.scenic.bearing) picks.push("Scenic");
                            if (c.bearing === nlScored.efficient.bearing) picks.push("Efficient");
                            const isWinner = c.bearing === nlScored.composite.winner.bearing;
                            if (isWinner) picks.push("★ Your Route");
                            return (
                              <tr
                                key={i}
                                className={`border-b border-slate-100 ${isWinner ? "bg-amber-50 font-medium" : ""}`}
                              >
                                <td className="py-1 pr-3">{i + 1}</td>
                                <td className="py-1 pr-3">{c.bearing}°</td>
                                <td className="py-1 pr-3">{(c.route.distanceMeters / METERS_PER_MILE).toFixed(2)}</td>
                                <td className="py-1 pr-3">{c.treeScore.treeCount}</td>
                                <td className="py-1 pr-3">{c.scenicScore.landmarkCount}</td>
                                <td className="py-1 pr-3">{c.scenicScore.waterfrontCount}</td>
                                <td className="py-1 pr-3">{ranked.compositeScore.toFixed(3)}</td>
                                <td className="py-1 pr-3">{picks.join(", ")}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-sm text-slate-700">
                      <strong>Your Route</strong> (highest composite score): bearing{" "}
                      {nlScored.composite.winner.bearing}°,{" "}
                      {(nlScored.composite.winner.route.distanceMeters / METERS_PER_MILE).toFixed(2)} mi, composite{" "}
                      {nlScored.composite.winner.compositeScore.toFixed(3)}.
                    </p>
                    <pre className="text-xs bg-slate-100 rounded-md p-3 overflow-x-auto">
                      {JSON.stringify(
                        nlScored.composite.ranked.map((c) => ({
                          bearing: c.bearing,
                          distanceMeters: Math.round(c.route.distanceMeters),
                          treeCount: c.treeScore.treeCount,
                          landmarkCount: c.scenicScore.landmarkCount,
                          waterfrontCount: c.scenicScore.waterfrontCount,
                          normalized: {
                            trees: Number(c.normalized.trees.toFixed(3)),
                            landmarks: Number(c.normalized.landmarks.toFixed(3)),
                            waterfront: Number(c.normalized.waterfront.toFixed(3)),
                          },
                          compositeScore: Number(c.compositeScore.toFixed(3)),
                        })),
                        null,
                        2
                      )}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {variants && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {VARIANT_ORDER.map((key) => {
              const v = variants[key];
              const meta = VARIANT_META[key];
              return (
                <Card key={key}>
                  <CardHeader>
                    <CardTitle className="text-base" style={{ color: meta.color }}>
                      {meta.label}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="rounded-lg overflow-hidden border border-slate-200 h-[260px]">
                      <MapContainer
                        center={[variants.start.lat, variants.start.lng]}
                        zoom={14}
                        className="h-full w-full"
                      >
                        <TileLayer
                          attribution='&copy; OpenStreetMap contributors'
                          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        />
                        <Polyline
                          positions={v.route.coords.map(([lng, lat]) => [lat, lng])}
                          pathOptions={{ color: meta.color, weight: 4 }}
                        />
                        <CircleMarker
                          center={[variants.start.lat, variants.start.lng]}
                          radius={7}
                          pathOptions={{ color: "#1d4ed8", fillColor: "#1d4ed8", fillOpacity: 1 }}
                        >
                          <Popup>Start / End</Popup>
                        </CircleMarker>
                        {variants.stop && (
                          <CircleMarker
                            center={[variants.stop.lat, variants.stop.lng]}
                            radius={7}
                            pathOptions={{ color: "#d97706", fillColor: "#d97706", fillOpacity: 1 }}
                          >
                            <Popup>{variants.stop.name || variants.stop.typeLabel}</Popup>
                          </CircleMarker>
                        )}
                      </MapContainer>
                    </div>
                    <p className="text-sm text-slate-700">
                      <strong>{(v.route.distanceMeters / METERS_PER_MILE).toFixed(2)} mi</strong>
                      {" — "}
                      {variantExplanation(key, v)}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {variants && (
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
