import { useQuery } from '@tanstack/react-query';

interface HealthResponse {
  status: 'ok';
}

async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`/api/health → HTTP ${res.status}`);
  return (await res.json()) as HealthResponse;
}

export function HomePage(): JSX.Element {
  const { data, error, isLoading } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: false,
  });

  return (
    <main className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-semibold">Arrears POC</h1>
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
    </main>
  );
}
