import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { getLoginUrl } from "@/const";

export function useAuth(options?: { redirectOnUnauthenticated?: boolean }) {
  const utils = trpc.useUtils();

  const { data: user, isLoading } = trpc.auth.me.useQuery(undefined, {
    // Don't hammer the server on transient failures — the session is either
    // valid or it isn't.
    retry: false,
    // Cache the result for 5 minutes to avoid a round-trip on every render.
    staleTime: 5 * 60 * 1000,
  });

  const { mutate: logoutMutate } = trpc.auth.logout.useMutation({
    onSuccess: () => {
      // Invalidate all cached queries so stale user data is never shown after
      // logout, then hard-navigate to the home page to clear React state.
      utils.invalidate();
      window.location.href = "/";
    },
  });

  // When a protected page is accessed without a session, redirect to the
  // Google login flow and pass the current path so the user lands back here
  // after they authenticate.
  useEffect(() => {
    if (!isLoading && !user && options?.redirectOnUnauthenticated) {
      window.location.href = getLoginUrl(
        window.location.pathname + window.location.search
      );
    }
  }, [isLoading, user, options?.redirectOnUnauthenticated]);

  return {
    user: user ?? null,
    isAuthenticated: !!user,
    isLoading,
    logout: () => logoutMutate(),
    login: (redirectTo?: string) => {
      window.location.href = getLoginUrl(
        redirectTo ?? window.location.pathname
      );
    },
  };
}
