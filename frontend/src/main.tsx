import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/lib/auth';
import { LoginPage } from './pages/Login';
import { OrganisationsListPage } from './pages/OrganisationsList';
import { OrganisationConfigPage } from './pages/OrganisationConfig';
import './index.css';

const queryClient = new QueryClient();

function AuthedRoutes(): JSX.Element {
  const auth = useAuth();
  if (auth.status === 'loading') {
    return (
      <main className="min-h-screen flex items-center justify-center text-muted-foreground">
        Loading…
      </main>
    );
  }
  if (auth.status !== 'authenticated') {
    return <LoginPage />;
  }
  return (
    <Routes>
      <Route path="/" element={<OrganisationsListPage />} />
      <Route
        path="/organisations/:id/config"
        element={<OrganisationConfigPage />}
      />
      <Route path="/auth/callback" element={<OrganisationsListPage />} />
    </Routes>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AuthedRoutes />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
