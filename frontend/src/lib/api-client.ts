// Tiny fetch wrapper. The auth provider sets the access token; everything
// else in the app talks through `apiFetch` so the bearer header is one-shot.

let bearerToken: string | null = null;

export function setAuthToken(token: string | null): void {
  bearerToken = token;
}

export interface ApiError extends Error {
  status: number;
  body: unknown;
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (bearerToken) headers.set('Authorization', `Bearer ${bearerToken}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const res = await fetch(input, { ...init, headers });
  return res;
}

export async function apiJson<T>(input: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(input, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err: ApiError = Object.assign(new Error(`${input} -> HTTP ${res.status}`), {
      status: res.status,
      body,
    });
    throw err;
  }
  return (await res.json()) as T;
}
