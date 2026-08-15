import { useState } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { geocodeAddress } from "@/lib/mapboxApi";
import { generateCandidateRoutes } from "@/lib/routeCandidates";
import { scoreRouteForTrees } from "@/lib/treeScoring";
import { findNearestStop } from "@/lib/stopFinder";

const METERS_PER_MILE = 1609.34;
const DEFAULT_CENTER = [40.7484, -73.9857]; // Midtown Manhattan, shown before a route exists

const STATUS_LABEL = {
  geocoding: "Finding your starting point…",
  findingStop: "Finding a stop along the way…",
  generating: "Generating candidate routes…",
  scoring: "Scoring routes against NYC tree data…",
};

export default function Home() {
  const [address, setAddress] = useState("");
  const [distanceMiles, setDistanceMiles] = useState("2");
  const [stopType, setStopType] = useState("none"); // none | coffee | library
  const [status, setStatus] = useState("idle"); // idle | geocoding | findingStop | generating | scoring | done | error
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { start, route, score, candidateCount, stop }

  const isLoading =
    status === "geocoding" ||
    status === "findingStop" ||
    status === "generating" ||
    status === "scoring";

  const handleGenerate = async (e) => {
    e.preventDefault();
    setError(null);
    setResult(null);

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
      const candidates = await generateCandidateRoutes(start, targetMeters, 4, stop);
      if (candidates.length === 0) {
        throw new Error("Couldn't generate any walking routes from that starting point.");
      }

      setStatus("scoring");
      const scored = await Promise.all(
        candidates.map(async (c) => ({
          ...c,
          score: await scoreRouteForTrees(c.route.coords),
        }))
      );

      scored.sort((a, b) => b.score.treeCount - a.score.treeCount);
      const best = scored[0];

      setResult({
        start,
        route: best.route,
        score: best.score,
        candidateCount: candidates.length,
        stop,
      });
      setStatus("done");
    } catch (err) {
      console.error(err);
      setError(err.message || "Something went wrong generating your route.");
      setStatus("error");
    }
  };

  const mapCenter = result ? [result.start.lat, result.start.lng] : DEFAULT_CENTER;

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Sidequest</h1>
          <p className="text-slate-600 text-sm">
            Generate a running route scored against real NYC tree data.
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
              <div className="w-40 space-y-1.5">
                <Label>Scenery</Label>
                <div className="h-10 flex items-center px-3 rounded-md border border-slate-200 bg-slate-100 text-sm text-slate-600">
                  Greenery 🌳
                </div>
              </div>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? STATUS_LABEL[status] : "Generate route"}
              </Button>
            </form>
            {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Route</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg overflow-hidden border border-slate-200 h-[420px]">
              <MapContainer center={mapCenter} zoom={14} className="h-full w-full">
                <TileLayer
                  attribution='&copy; OpenStreetMap contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                {result && (
                  <>
                    <Polyline
                      positions={result.route.coords.map(([lng, lat]) => [lat, lng])}
                      pathOptions={{ color: "#16a34a", weight: 4 }}
                    />
                    <CircleMarker
                      center={[result.start.lat, result.start.lng]}
                      radius={8}
                      pathOptions={{ color: "#1d4ed8", fillColor: "#1d4ed8", fillOpacity: 1 }}
                    >
                      <Popup>Start / End</Popup>
                    </CircleMarker>
                    {result.score.trees.slice(0, 400).map((t, i) => (
                      <CircleMarker
                        key={i}
                        center={[t.lat, t.lng]}
                        radius={3}
                        pathOptions={{
                          color: "#16a34a",
                          fillColor: "#16a34a",
                          fillOpacity: 0.7,
                          weight: 0,
                        }}
                      />
                    ))}
                  </>
                )}
              </MapContainer>
            </div>
          </CardContent>
        </Card>

        {result && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Score</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-slate-700">
              <p>
                This route is about{" "}
                <strong>{(result.route.distanceMeters / METERS_PER_MILE).toFixed(2)} mi</strong>{" "}
                and passes within {result.score.bufferMeters}m of{" "}
                <strong>{result.score.treeCount} trees</strong>, per the NYC 2015 Street Tree
                Census — the best of {result.candidateCount} candidate routes generated for this
                trip.
              </p>
              <p className="text-xs text-slate-500">
                Tree data is a 2015–2016 snapshot from NYC Open Data, not a live feed — actual
                tree cover today may differ slightly.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
