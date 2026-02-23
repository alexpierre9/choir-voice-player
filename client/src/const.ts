export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

export const APP_TITLE = import.meta.env.VITE_APP_TITLE || "Choir Voice Player";

export const APP_LOGO =
  import.meta.env.VITE_APP_LOGO ||
  "https://placehold.co/128x128/E1E7EF/1F2937?text=Choir";

/**
 * Returns the login page URL, optionally embedding a post-login destination
 * so the user is returned to where they were after signing in.
 */
export const getLoginUrl = (redirectTo?: string) => {
  const path = redirectTo && redirectTo !== "/" ? redirectTo : undefined;
  return path ? `/login?redirect=${encodeURIComponent(path)}` : "/login";
};
