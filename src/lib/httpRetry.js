/**
 * Fetches JSON with a couple of retries on transient failures (503 from an
 * overloaded/rate-limited endpoint, or a raw network error) using a short
 * backoff. NYC Open Data's public unauthenticated endpoint throttles hard
 * under bursty load, and this app's larger candidate pools generate real
 * bursts — this keeps a single overloaded moment from failing the whole
 * generation.
 */
export async function fetchJsonWithRetry(url, { retries = 2, backoffMs = 400 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
      if (res.status === 503 && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
        continue;
      }
      throw new Error(`Request failed: ${res.status}`);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
}
