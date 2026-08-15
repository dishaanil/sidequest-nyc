/**
 * Maps over `items` with at most `limit` calls to `fn` in flight at once.
 * Larger candidate pools mean more parallel network calls (route generation,
 * tree/scenic scoring); firing them all via a single Promise.all can trip
 * rate limits or overwhelm the browser's connection pool, so this caps
 * concurrency instead of removing parallelism entirely.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
