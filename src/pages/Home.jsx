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
              placeholder='e.g. "I\'m starting at Union Square, ending at Washington Square, run 2 miles, stop at a coffee shop on the way, and I want my route to be as green as possible."'
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
