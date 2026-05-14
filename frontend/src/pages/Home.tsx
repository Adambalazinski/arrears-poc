import { useQuery } from '@tanstack/react-query';
import { apiJson } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

interface HealthResponse {
  status: 'ok';
}

function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => apiJson<HealthResponse>('/api/health'),
    retry: false,
  });
}

export function HomePage(): JSX.Element {
  const auth = useAuth();
  const { data, error, isLoading } = useHealth();

  return (
    <main className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center gap-3">
      <h1 className="text-4xl font-semibold">Arrears POC</h1>
      <p className="text-muted-foreground">
        Signed in as <code>{auth.user?.email}</code> ({auth.user?.id})
      </p>
      <p className="text-muted-foreground">
        Backend health:{' '}
        {isLoading
          ? 'checking…'
          : error
            ? `error — ${error instanceof Error ? error.message : 'unknown'}`
            : data?.status === 'ok'
              ? 'ok'
              : 'unexpected'}
      </p>
      <button className="text-sm underline text-muted-foreground" onClick={auth.logout}>
        sign out
      </button>
    </main>
  );
}
