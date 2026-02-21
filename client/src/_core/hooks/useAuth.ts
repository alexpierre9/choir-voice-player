import { useQuery } from '@tanstack/react-query';
import { trpc } from '../trpc';

const DEMO_USER = {
  id: 'lex-user-001',
  name: 'Lex',
  email: 'lex@babtech.io',
  role: 'admin' as const,
};

export function useAuth(options?: { redirectOnUnauthenticated?: boolean }) {
  const { data: user, isLoading: loading } = useQuery({
    queryKey: ['auth-me'],
    queryFn: async () => {
      try {
        // This will fail in demo mode, and we'll fall back to the demo user.
        return await trpc.auth.me.query();
      } catch {
        return DEMO_USER;
      }
    },
    initialData: DEMO_USER,
  });

  return {
    user: user || DEMO_USER,
    isAuthenticated: true,
    isLoading: false,
    logout: () => {}, // Logout does nothing in demo mode
  };
}
