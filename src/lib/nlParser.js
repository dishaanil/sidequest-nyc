import { base44 } from "@/api/base44Client";

export const NL_PARSE_SCHEMA = {
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
    preference_emphasis: {
      type: "string",
      enum: ["greenery", "landmarks", "waterfront", "balanced"],
      description:
        "Which scenery type the user emphasized. Use 'balanced' if no single preference is clearly emphasized.",
    },
  },
  required: ["start", "end", "distance_miles", "stop_type", "preference_emphasis"],
};

const PROMPT_PREFIX = `You are parsing a natural-language request for a running route into structured trip parameters. Read the request carefully and extract exactly the fields in the schema. Use null for any field that truly isn't mentioned (except preference_emphasis, which defaults to "balanced" rather than null). Do not invent details the user didn't state.

Request: "`;

/**
 * Parses a free-text run description into structured fields via Base44's
 * built-in LLM integration (InvokeLLM). Debug/verification step only — the
 * result isn't wired into route generation yet.
 */
export async function parseNaturalLanguageRequest(text) {
  return base44.integrations.Core.InvokeLLM({
    prompt: PROMPT_PREFIX + text + '"',
    response_json_schema: NL_PARSE_SCHEMA,
  });
}
