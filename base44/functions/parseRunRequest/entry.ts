import { createClientFromRequest } from "npm:@base44/sdk";

const NL_PARSE_SCHEMA = {
  type: "object",
  properties: {
    start: {
      type: ["string", "null"],
      description:
        "The starting location the user mentions, as a short geocode-able place name or address. Null if truly not mentioned.",
    },
    end: {
      type: ["string", "null"],
      description:
        "The ending location, only if different from the start. Null if the user implies a loop back to the start (no separate end mentioned).",
    },
    distance_miles: {
      type: ["number", "null"],
      description:
        "Target run distance in miles. Convert other units (km, etc.) to miles. Null if not mentioned.",
    },
    stop_type: {
      type: ["string", "null"],
      description:
        "A short lowercase keyword for a requested stop along the way, e.g. 'coffee', 'library', 'grocery'. Null if no stop is mentioned.",
    },
    stop_position_hint: {
      type: ["string", "null"],
      enum: ["early", "middle", "late", null],
      description:
        "Only set this if the user's phrasing implies WHERE along the route the stop should happen -- e.g. 'before I get home', 'near the end', 'on my way out', 'right after I start', 'early in my run'. Classify as 'early' (roughly the first 5-25% of the route), 'middle' (~50%), or 'late' (roughly the last 85-95%, e.g. right before returning home). Null if the user didn't express any position preference for the stop -- do NOT guess one just because a stop type was mentioned, since each stop type already has its own sensible default the caller applies when this is null.",
    },
    preference_emphasis: {
      type: "string",
      enum: ["greenery", "landmarks", "waterfront", "balanced"],
      description:
        "Which scenery type the user emphasized. Use 'balanced' if no single preference is clearly emphasized.",
    },
  },
  required: ["start", "end", "distance_miles", "stop_type", "stop_position_hint", "preference_emphasis"],
};

const PROMPT_PREFIX = `You are parsing a natural-language request for a running route into structured trip parameters. Read the request carefully and extract exactly the fields in the schema. Use null for any field that truly isn't mentioned (except preference_emphasis, which defaults to "balanced" rather than null). Do not invent details the user didn't state.

Request: "`;

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const { text } = await req.json();

    if (!text || typeof text !== "string") {
      return Response.json({ error: "Missing 'text' parameter." }, { status: 400 });
    }

    const parsed = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: PROMPT_PREFIX + text + '"',
      response_json_schema: NL_PARSE_SCHEMA,
    });

    return Response.json({ parsed });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
