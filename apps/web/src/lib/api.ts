/**
 * Szerveroldali API-kliens. A böngésző azonos originről éri el az API-t
 * (Next rewrite), a szerverkomponensek pedig a konténerbelső címről,
 * a session cookie továbbításával.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const INTERNAL = process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Ha true, 401 esetén a bejelentkező oldalra irányít. */
  redirectOnAuth?: boolean;
  cache?: RequestCache;
  revalidate?: number;
}

/** Szerverkomponensből hívható API-kérés. */
export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const store = await cookies();
  const cookieHeader = store.getAll().map((c) => `${c.name}=${c.value}`).join('; ');

  const res = await fetch(`${INTERNAL}/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    cache: options.cache ?? 'no-store',
    ...(options.revalidate !== undefined ? { next: { revalidate: options.revalidate } } : {}),
  });

  if (res.status === 401 && options.redirectOnAuth !== false) {
    redirect('/belepes');
  }

  const text = await res.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }

  if (!res.ok) {
    const err = (payload as { error?: { code?: string; message?: string; detail?: unknown } })?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `A kérés meghiúsult (HTTP ${res.status}).`,
      err?.detail,
    );
  }
  return payload as T;
}

/** Hibatűrő változat: hiba esetén a megadott alapértéket adja vissza. */
export async function apiSafe<T>(path: string, fallback: T, options: ApiOptions = {}): Promise<T> {
  try {
    return await api<T>(path, options);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/belepes');
    return fallback;
  }
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'viewer' | 'reviewer' | 'catalog_manager' | 'source_manager' | 'admin';
}

export async function currentSession(): Promise<{ user: SessionUser; csrfToken: string } | null> {
  try {
    return await api<{ user: SessionUser; csrfToken: string }>('/auth/me', { redirectOnAuth: false });
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<{ user: SessionUser; csrfToken: string }> {
  const session = await currentSession();
  if (!session) redirect('/belepes');
  return session;
}

// A formázók külön, kliensbiztos modulban élnek; innen újraexportálva a
// szerverkomponensek egyetlen importtal is elérik őket.
export {
  huf, hufShort, pct, num, ago, dateTime, dateOnly, volume,
} from './format';
