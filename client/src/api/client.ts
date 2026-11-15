import { useAuthStore } from '../stores/authStore.js';

const API_BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE_URL ??
  '/api/v1';

export class ApiClientError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = 'API_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  retryOn401 = true
): Promise<T> {
  const { accessToken, refreshToken, setAuth, clearAuth } = useAuthStore.getState();

  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (response.status === 401 && retryOn401 && refreshToken && !path.startsWith('/auth/')) {
    try {
      const refreshRes = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        credentials: 'include',
      });
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json();
        setAuth(
          refreshData.data.user,
          refreshData.data.accessToken,
          refreshData.data.refreshToken
        );
        return apiRequest<T>(path, options, false);
      } else {
        clearAuth();
      }
    } catch {
      clearAuth();
    }
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.success) {
    throw new ApiClientError(
      payload?.error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      payload?.error?.code ?? 'REQUEST_FAILED'
    );
  }

  return payload.data as T;
}
