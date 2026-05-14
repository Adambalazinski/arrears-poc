import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiJson, setAuthToken } from './api-client';

export interface AuthUser {
  id: string;
  email: string;
}

interface AuthState {
  status: 'loading' | 'authenticated' | 'unauthenticated' | 'error';
  user: AuthUser | null;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  /** Store an access token and re-resolve the current user. */
  setToken(token: string): Promise<void>;
  /** Drop the token and become unauthenticated. */
  logout(): void;
  /** Manually re-fetch /api/me (e.g. after returning from a hosted UI). */
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    user: null,
    error: null,
  });

  const fetchMe = useCallback(async (): Promise<void> => {
    try {
      const user = await apiJson<AuthUser>('/api/me');
      setState({ status: 'authenticated', user, error: null });
    } catch (err) {
      if (isUnauthorized(err)) {
        setState({ status: 'unauthenticated', user: null, error: null });
      } else {
        setState({
          status: 'error',
          user: null,
          error: err instanceof Error ? err.message : 'unknown error',
        });
      }
    }
  }, []);

  const setToken = useCallback(
    async (token: string) => {
      setAuthToken(token);
      await fetchMe();
    },
    [fetchMe],
  );

  const logout = useCallback(() => {
    setAuthToken(null);
    setState({ status: 'unauthenticated', user: null, error: null });
  }, []);

  // Mount: try /api/me once. In dev-bypass mode this succeeds with no token.
  useEffect(() => {
    void fetchMe();
  }, [fetchMe]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, setToken, logout, refresh: fetchMe }),
    [state, setToken, logout, fetchMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

function isUnauthorized(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status: number }).status === 401
  );
}
