const BASE = `${import.meta.env.VITE_API_URL ?? 'http://localhost:3000'}/api/v1`;
const TOKEN_KEY = 'pc_token';
const SLOW_MS = 5000;
// Holgado para un arranque en frío de Render, que puede tardar cerca de un minuto.
const TIMEOUT_MS = 90000;

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Sin respuesta del servidor: la operación pudo haberse aplicado o no. */
export class NetworkError extends Error {
  constructor() {
    super('No se pudo conectar con el servidor.');
  }
}

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* almacenamiento bloqueado: la sesión dura lo que la pestaña */ }
}

let memoryToken: string | null = storageGet(TOKEN_KEY);
let onUnauthorized: () => void = () => {};
let onSlow: (slow: boolean) => void = () => {};
let inFlight = 0;
let slowTimer: ReturnType<typeof setTimeout> | undefined;

export const getToken = () => memoryToken;
export function setToken(token: string | null): void {
  memoryToken = token;
  storageSet(TOKEN_KEY, token);
}
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };
export const setSlowHandler = (fn: (slow: boolean) => void) => { onSlow = fn; };

function trackStart() {
  inFlight++;
  if (!slowTimer) slowTimer = setTimeout(() => onSlow(true), SLOW_MS);
}
function trackEnd() {
  inFlight--;
  if (inFlight === 0) {
    clearTimeout(slowTimer);
    slowTimer = undefined;
    onSlow(false);
  }
}

/**
 * Una misma operación que falló por red reusa su clave al reintentarla a mano:
 * si el servidor ya la había aplicado, devuelve la respuesta guardada.
 */
const retryKeys = new Map<string, string>();

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotent?: boolean;
}

export async function api<T>(path: string, { method = 'GET', body, idempotent }: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (memoryToken) headers.Authorization = `Bearer ${memoryToken}`;
  const payload = idempotent ? body ?? {} : body;
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const serialized = payload !== undefined ? JSON.stringify(payload) : undefined;

  const operation = `${method} ${path} ${serialized ?? ''}`;
  if (idempotent) {
    const key = retryKeys.get(operation) ?? crypto.randomUUID();
    retryKeys.set(operation, key);
    headers['Idempotency-Key'] = key;
  }

  trackStart();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: serialized, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new NetworkError();
  } finally {
    trackEnd();
  }

  if (idempotent) retryKeys.delete(operation);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && data?.error === 'unauthorized') onUnauthorized();
    const { error, message, ...extra } = data ?? {};
    throw new ApiRequestError(res.status, error ?? 'error', message ?? 'Ocurrió un error.', extra);
  }
  return data as T;
}

export { storageGet, storageSet };
