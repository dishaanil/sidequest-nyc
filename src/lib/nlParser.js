import { base44 } from "@/api/base44Client";

/**
 * Parses a free-text run description into structured fields via a Base44
 * backend function (parseRunRequest), which calls InvokeLLM server-side —
 * InvokeLLM is blocked from direct frontend calls, so this can't call it
 * directly from the browser. Debug/verification step only — the result
 * isn't wired into route generation yet.
 */
export async function parseNaturalLanguageRequest(text) {
  const result = await base44.functions.invoke("parseRunRequest", { text });
  if (result?.data?.error) {
    throw new Error(result.data.error);
  }
  return result?.data?.parsed;
}
