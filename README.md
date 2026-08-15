# Sidequest — NYC

Sidequest is a personalized running-route app for NYC. A runner describes what they
want in plain English — a distance, a starting point, a scenery preference, maybe a
stop to make along the way — and Sidequest generates a real, street-following route
and scores it against live NYC civic data instead of guessing what's "scenic."

The core idea: **scoring is grounded in real NYC Open Data, not hallucinated.** Every
Greenery/Scenic/Running Quality number shown to the user is computed deterministically
from actual tree, park, landmark, and waterfront-access records pulled live from NYC's
Socrata API — an LLM never invents a score.

---

## What it does

A user types something like:

> "Start at Union Square, end at Bobst Library, run 2 miles, stop at a coffee shop on
> the way, and I want lots of greenery."

and Sidequest:

1. **Parses the request** into structured fields (start, end, distance, stop type,
   stop position hint, scenery preference) via an LLM constrained to a strict schema.
2. **Geocodes** the start/end locations (Mapbox Search Box API).
3. **Finds a sidequest stop**, if requested, from real NYC Open Data — positioned
   deliberately along the route rather than just "nearest to the start."
4. **Generates a pool of candidate routes** for the requested distance (varying
   bearings, biased toward real nearby greenery/landmarks/waterfront where useful),
   each following actual streets via the Mapbox Directions API.
5. **Scores every candidate** on three deterministic 0–100 metrics computed from real
   NYC Open Data geometry: Greenery, Scenic, and Running Quality (distance accuracy).
6. **Ranks candidates** with a composite score that treats distance accuracy as a real
   multiplicative penalty, not a soft tiebreaker, and picks a **Best Match**.
7. **Explains the choice** in 1–2 natural sentences generated from the actual computed
   comparison numbers (never invented by the LLM).
8. **Shows three labeled alternatives** — Greenest, Most Scenic (or Most Waterfront /
   Most Historic depending on what was asked for), and a stop-type-aware "Best X
   Route" — so the user can compare trade-offs at a glance.

---

## Feature list

### Natural-language + form input
- Free-text "Describe your run" box is the primary input path, parsed by an LLM into
  structured trip parameters (start, end, distance, stop type, stop position hint,
  scenery preference) via a strict JSON schema.
- A structured form (start / distance / stop dropdown) is available as a secondary,
  less prominent fallback.
- Cycling placeholder examples in the text box so an empty input still shows concrete,
  copyable examples of what to type.
- Real loading state: an inline spinner plus a status label that updates through each
  pipeline stage ("Reading your request…", "Finding a stop along the way…",
  "Generating candidate routes…", "Scoring routes against NYC open data…",
  "Explaining the choice…"), with the input disabled while a request is in flight.

### Route generation
- Both **loop** (start = end) and **point-to-point** (distinct start/end) route
  shapes are supported.
- Candidate routes are generated at multiple bearings — some evenly spread, some
  biased toward real nearby tree/landmark/waterfront density pulled live from NYC
  Open Data — so candidates are genuinely scenery-directed, not blindly rotated.
- Actual street-network paths are computed via the Mapbox Directions API (walking
  profile), not straight lines or simplified geometry.
- Distance is treated as a real constraint: candidates within ±5% of the requested
  distance are preferred; the search widens to ±10% only if nothing qualifies.
- Near-duplicate candidates (routes that share most of their geometry) are
  deduplicated by resampling and comparing point-to-route distances, so the
  alternative pool is genuinely diverse.
- A detour-plausibility check rejects candidates whose real walking distance is
  wildly disproportionate to the straight-line distance of their waypoints — the
  signature of a route that had to detour miles out of its way around an obstacle
  (a river with no nearby bridge, etc.) rather than following a sensible path.

### Deterministic real-data scoring
- **Greenery score (0–100):** tree density near the route (2015 Street Tree Census)
  plus park/green-space adjacency, expressed as an "exposure percentage" — the
  fraction of the route's length that's actually near trees/parks — rather than a
  raw, batch-relative count.
- **Scenic score (0–100):** a weighted blend — 35% waterfront exposure, 25% park
  exposure, 20% landmark exposure, 20% tree density — computed the same
  exposure-percentage way from Waterfront Public Access Areas, Parks Properties, and
  Designated Landmarks datasets.
- **Running Quality score (0–100):** how closely the route's actual distance matches
  the requested distance.
- All three scores come with a human-readable evidence line (e.g. "calculated from
  349 trees within 50m (11.29/100m, vs a 20/100m reference for a fully tree-lined
  block), 28% of route adjacent to park/green space") so the score is visibly backed
  by real numbers, not just presented as a black box.
- A composite ranking multiplies the scenery score relevant to the user's stated
  preference by a distance-accuracy factor, so a "prettier" route that's far off the
  requested distance can't automatically beat a route that's actually the right
  length.

### Sidequest stops
- Optional required waypoint (currently coffee ☕ and library 📚, backed by real NYC
  Open Data — DOHMH Restaurant Inspection Results filtered to coffee/tea, and the
  NYC LIBRARY dataset).
- **Position-aware placement**, not just "nearest to the start point": each stop type
  has a sensible default position along the route (coffee defaults to ~50% of the
  way through; other types can default earlier or later), and explicit phrasing like
  "stop for coffee near the end" or "before I get home" overrides the default.
- The route-generation waypoint order and detour padding are structured so the
  requested position is actually honored in the final route, not just used to pick
  which POI to search near.
- The chosen stop is shown as its own chip (emoji + name + "midway through your
  run" / "near the end of your run" phrasing), using the same emoji on the map
  marker and in the text so they stay visually consistent.

### "Why Sidequest chose this"
- A backend function computes structured comparison numbers first (distance
  deviation, greenery improvement vs. the shortest alternative, scenic score, stop
  position) as pure data, then a separate LLM call turns only that data into 1–2
  natural sentences — the LLM narrates already-computed numbers, it never invents or
  recalculates any of them.
- When running quality is very low, the explanation is required to lead with that as
  the primary caveat rather than burying it under a scenery discussion — enforced
  both by the prompt and by a deterministic, always-shown warning banner that doesn't
  depend on the LLM remembering the instruction.

### Contextual alternative labels
- The three alternative-route cards are labeled based on what was actually asked
  for — e.g. a greenery + coffee request surfaces "Maximum Greenery" and "Best
  Coffee Route"; a waterfront-emphasis request surfaces "Most Waterfront" instead of
  a generic "Most Scenic." The hero card is always labeled "Best Match."

### Result UI
- **Hero result card:** a large, real-height interactive map with the winning route,
  distinct emoji markers for start (🚩), end (🏁), and any sidequest stop (☕ 📚 🥐
  📦 💊 🛒, falling back to 📍), a clean stat row (distance, estimated time, and the
  three scores as large bold numbers with small labels), the stop chip, and the
  "why chose this" explanation as its own visually distinct callout.
- **Alternative-route cards:** consistently sized, with larger map thumbnails and a
  compact all-three-scores row (the score that actually drove that variant's
  selection is bold/colored, the other two shown muted for comparison) so options can
  be compared at a glance without opening each one — deliberately smaller and less
  visually prominent than the hero.
- Estimated run time is computed from a stated jogging-pace assumption alongside the
  real distance.

### "Your Runs" dashboard
- A personalized greeting ("Hey Disha! 👋") and avatar badge at the top of the app.
- A "Your Runs" section showing past-run cards (route name, distance, relative date,
  a Greenery/Scenic score, and — on some of them — a sidequest-stop chip, so it's
  visually clear stops are optional) with small map thumbnails.
- Each thumbnail's route line is generated by seeding a small set of real-location
  control points through a deterministic "streetify" pass that turns a straight/clean
  shape into an irregular, multi-segment, grid-following line — so it reads visually
  as a real generated route rather than a drawn polygon — and the map view is tightly
  fit to each route's bounds so the path is the clear focal point of the thumbnail.

### Visual design
- A custom color palette (warm cream background, deep pine-green primary, terracotta
  and purple accents) replacing the default framework grayscale, driven centrally
  through theme CSS variables so every button/input/card picked it up automatically.
- A distinct heading typeface (Space Grotesk) paired with the system body font for
  real typographic hierarchy.
- A custom flat stick-figure runner icon (mid-stride, dynamic pose) used as the brand
  mark in the header and as the browser favicon.
- Consistent spacing, card sizing, and visual weight throughout so the hero result
  clearly reads as the page's focal point and secondary sections (alternatives, run
  history) read as supporting content.

---

## Architecture

### MCP server: `nyc-open-data`
A custom Model Context Protocol server exposing two generic tools instead of one
hardcoded tool per dataset:
- `search_datasets(query, limit, geoOnly)` — keyword-searches the NYC Open Data
  catalog and reports which matching datasets have usable geo columns.
- `query_dataset(datasetId, select, where, limit)` — runs a SoQL query against any
  dataset on the platform by its Socrata id.

### Base44 backend functions
LLM calls (`InvokeLLM`) can only be made server-side via
`base44.asServiceRole.integrations.Core.InvokeLLM`, so both LLM-touching steps are
implemented as backend functions invoked from the frontend:
- **`parseRunRequest`** — turns the free-text run description into structured JSON
  (start, end, distance, stop type, stop position hint, scenery preference) against a
  strict schema, instructed not to invent details the user didn't state.
- **`explainRoute`** — takes pre-computed comparison stats as input and returns 1–2
  natural sentences explaining the winning route, constrained to only use the given
  numbers.

### Frontend
React (Vite) + Tailwind + shadcn/ui components, with `react-leaflet`/Leaflet for maps
and `lucide-react` for supporting icons. Key library modules:

| File | Responsibility |
|---|---|
| `src/lib/mapboxApi.js` | Geocoding (Search Box API) and turn-by-turn walking directions |
| `src/lib/routeCandidates.js` | Candidate route generation, tolerance filtering, dedup, detour-plausibility checks |
| `src/lib/directionalBias.js` | Biases candidate bearings toward real nearby greenery/scenery |
| `src/lib/scoreBreakdown.js` | Deterministic Greenery/Scenic/Running Quality scoring from NYC Open Data geometry |
| `src/lib/compositeScoring.js` | Ranks candidates with distance treated as a real multiplicative penalty |
| `src/lib/stopFinder.js` | Finds real coffee/library stops from NYC Open Data near a target point |
| `src/lib/stopPosition.js` | Resolves and geometrically targets where a stop should sit along the route |
| `src/lib/stopEmoji.js` | Shared stop-type → emoji mapping (map markers and chips stay in sync) |
| `src/lib/variantLabels.js` | Contextual labels for the alternative-route cards |
| `src/lib/nlParser.js` / `explainRoute.js` | Thin clients calling the two backend functions |
| `src/lib/geo.js` | Shared geometry math (haversine distance, bearings, sampling, bounding boxes) |
| `src/pages/Home.jsx` | The entire UI: input, pipeline orchestration, hero result, alternatives, dashboard |

---

## Data sources

All scoring and stop-finding is backed by live queries against NYC Open Data
(`data.cityofnewyork.us`) via the Socrata API:

| Purpose | Dataset | Socrata ID |
|---|---|---|
| Greenery scoring | 2015 Street Tree Census – Tree Data | `uvpi-gqnh` |
| Scenic scoring (landmarks) | Designated and Calendared Buildings and Sites | `ncre-qhxs` |
| Scenic scoring (waterfront) | Waterfront Public Access Areas (WPAAs) | `9y58-8zvz` |
| Scenic scoring (parks) | Parks Properties | `enfh-gkve` |
| Coffee stops | DOHMH Restaurant Inspection Results (filtered to Coffee/Tea) | `43nn-pn8j` |
| Library stops | LIBRARY | `feuq-due4` |

---

## Tech stack

- **Frontend:** React, Vite, Tailwind CSS, shadcn/ui, react-leaflet / Leaflet,
  lucide-react
- **Routing/geocoding:** Mapbox Search Box API, Mapbox Directions API
- **Civic data:** NYC Open Data (Socrata SODA API), accessed via a custom MCP server
- **LLM:** Base44's `InvokeLLM` integration, called server-side from two backend
  functions for natural-language parsing and result explanation
- **Platform:** Base44 (hosting, backend functions, deployment)

---

## Local development

```bash
npm install
npm install -g base44@latest
base44 dev
```

`base44 dev` starts the local Base44 backend and, per this project's
`base44/config.jsonc` `serveCommand`, also starts the Vite frontend dev server. Use
the frontend URL it prints.

To work on the frontend only, against the hosted Base44 backend:

```bash
npm run dev
```

with a `.env.local` containing:

```bash
VITE_BASE44_APP_ID=your_app_id
VITE_BASE44_APP_BASE_URL=https://your-app.base44.app
```

To publish changes, push to git and open the Base44 dashboard:

```bash
base44 dashboard open
```
