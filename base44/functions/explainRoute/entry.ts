import { createClientFromRequest } from "npm:@base44/sdk";

const PROMPT_PREFIX = `You are explaining why a specific running route was chosen over its alternatives. You will be given a JSON object of pre-computed numbers (distances, scores, percentages). Use ONLY these numbers — do not invent, estimate, or restate a number that isn't present in the data, and do not describe streets, neighborhoods, or scenery you weren't told about. Write 1-2 natural, conversational sentences comparing the chosen route to the alternative(s) using the most relevant numbers (e.g. how much better its greenery score is than the shortest option, how close it lands to the requested distance, where a requested stop falls along the route). Do not just list every field.

Data: `;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    explanation: {
      type: "string",
      description: "1-2 natural sentences explaining why this route was chosen, using only the given numbers.",
    },
  },
  required: ["explanation"],
};

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const { stats } = await req.json();

    if (!stats) {
      return Response.json({ error: "Missing 'stats' parameter." }, { status: 400 });
    }

    const result = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: PROMPT_PREFIX + JSON.stringify(stats),
      response_json_schema: RESPONSE_SCHEMA,
    });

    return Response.json({ explanation: result.explanation });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
