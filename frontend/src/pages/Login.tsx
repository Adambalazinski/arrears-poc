import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';

const COGNITO_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN;
const COGNITO_CLIENT_ID = import.meta.env.VITE_ARREARS_COGNITO_CLIENT_ID;
const REDIRECT_URI =
  import.meta.env.VITE_COGNITO_REDIRECT_URI ?? `${window.location.origin}/auth/callback`;

export function LoginPage(): JSX.Element {
  const auth = useAuth();

  // After the Cognito hosted UI redirects back, the access token arrives in
  // the URL hash (#access_token=...&id_token=...). Pull it out and hand it
  // to the auth provider.
  useEffect(() => {
    if (window.location.hash.includes('access_token=')) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const token = params.get('access_token');
      if (token) {
        void auth.setToken(token).then(() => {
          window.history.replaceState({}, '', '/');
        });
      }
    }
  }, [auth]);

  if (auth.status === 'authenticated') return <p>Already signed in.</p>;

  const canRedirect = COGNITO_DOMAIN && COGNITO_CLIENT_ID;

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-semibold">Arrears POC — sign in</h1>
      {canRedirect ? (
        <a
          className="rounded bg-primary text-primary-foreground px-4 py-2"
          href={
            `${COGNITO_DOMAIN}/login` +
            `?client_id=${encodeURIComponent(COGNITO_CLIENT_ID)}` +
            `&response_type=token` +
            `&scope=openid+email` +
            `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
          }
        >
          Sign in with Cognito
        </a>
      ) : (
        <p className="text-muted-foreground max-w-md text-center">
          Cognito is not configured. Either set <code>VITE_COGNITO_DOMAIN</code> +{' '}
          <code>VITE_ARREARS_COGNITO_CLIENT_ID</code>, or run the backend with{' '}
          <code>DEV_AUTH_BYPASS_USER_ID</code> to bypass auth locally.
        </p>
      )}
      {auth.status === 'error' && (
        <p className="text-destructive text-sm">Auth check failed: {auth.error}</p>
      )}
    </main>
  );
}
