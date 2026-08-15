import { base44 } from "@/api/base44Client";

/**
 * Turns pre-computed comparison stats (distances, scores, percentages — see
 * buildComparisonStats in Home.jsx) into 1-2 natural sentences via a
 * backend function. The LLM narrates already-computed numbers; it never
 * calculates or invents any of its own.
 */
export async function explainRouteChoice(stats) {
  const result = await base44.functions.invoke("explainRoute", { stats });
  if (result?.data?.error) {
    throw new Error(result.data.error);
  }
  return result?.data?.explanation;
}
