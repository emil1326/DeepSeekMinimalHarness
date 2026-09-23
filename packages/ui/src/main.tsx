import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import './styles.css';

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // The daemon pushes a nudge when something changes, so this is only a
      // safety net for a socket that dropped.
      staleTime: 1000,
      retry: 1,
    },
  },
});

const root = document.getElementById('root');
if (root === null) throw new Error('no #root to render into');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
