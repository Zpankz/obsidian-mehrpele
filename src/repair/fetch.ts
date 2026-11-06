/** FetchLike adapter over Obsidian's requestUrl (mockable for tests). */
import type { FetchLike } from "pele-render/repair";

export interface RequestUrlLike {
  (req: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    throw?: boolean;
  }): Promise<{ status: number; json: unknown; text: string }>;
}

function abortError(): Error {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

/** Race a promise against an AbortSignal (requestUrl itself is not abortable). */
export function raceWithSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e as Error);
      },
    );
  });
}

export function makeFetchLike(requestUrl: RequestUrlLike): FetchLike {
  return (url, init) => {
    const p = requestUrl({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      throw: false,
    }).then((r) => ({
      status: r.status,
      json: async () => r.json,
      text: async () => r.text,
    }));
    return raceWithSignal(p, init.signal);
  };
}
