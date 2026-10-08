export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** fetch + JSON with a readable error that includes the provider's message. */
export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message || j?.error_description || j?.message || j?.Message || detail;
    } catch {
      /* not JSON */
    }
    throw new HttpError(res.status, `${new URL(url).host} returned ${res.status}: ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}
