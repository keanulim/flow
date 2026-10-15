// Browser-side request helpers shared by the UI components.

/**
 * Dev-only free test mode: run `localStorage.setItem("flow.mock", "1")` in the
 * browser console and replies come from the mock instead of the API. Use
 * "think" for a 2s pause before the first chunk. Remove the item to go back.
 */
export function devMockHeader(): Record<string, string> {
  if (process.env.NODE_ENV === "production") return {};
  try {
    const mode = localStorage.getItem("flow.mock"); // "1" or "think"
    return mode === "1" || mode === "think" ? { "x-flow-mock": mode } : {};
  } catch {
    return {};
  }
}

/** A request that failed in a way worth telling the user about. */
export class ApiError extends Error {}

/** fetch() that turns network failures and non-2xx responses into readable ApiErrors. */
export async function api(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (init?.signal?.aborted) throw e; // a deliberate abort, not a failure
    throw new ApiError("Can't reach the Flow server. Is it running?");
  }
  if (!res.ok) {
    // Prefer the server's own message ({ error }) when it sends one.
    const detail = await res
      .clone()
      .json()
      .then((b: { error?: string }) => b.error)
      .catch(() => undefined);
    throw new ApiError(detail ?? `Request failed (${res.status}). Try again.`);
  }
  return res;
}
