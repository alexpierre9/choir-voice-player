export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

export const APP_TITLE = import.meta.env.VITE_APP_TITLE || "App";

export const APP_LOGO =
  import.meta.env.VITE_APP_LOGO ||
  "https://placehold.co/128x128/E1E7EF/1F2937?text=App";

/**
 * Generate a Google OAuth login URL.
 *
 * @param redirectTo - Optional relative path to redirect the user to after a
 *   successful login (e.g. "/upload"). Defaults to "/".
 *
 * A cryptographic nonce is generated and stored in a short-lived cookie so
 * the server can verify it in the OAuth callback and reject forged state
 * parameters (CSRF protection).
 */
export const getLoginUrl = (redirectTo?: string) => {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  const redirectUri = `${window.location.origin}/api/oauth/callback`;

  // Generate a one-time nonce and store it in a cookie (SameSite=Lax keeps it
  // from being sent in cross-site requests while still surviving the Google
  // redirect back to our origin).
  const nonce = crypto.randomUUID();
  document.cookie = `oauth_nonce=${nonce}; path=/; SameSite=Lax; Max-Age=600`;

  // Encode nonce, post-login destination, and redirect_uri together so the
  // server callback has everything it needs in one tamper-evident blob.
  const state = btoa(
    JSON.stringify({
      nonce,
      redirectTo: redirectTo ?? "/",
      redirectUri,
    })
  );

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");

  return url.toString();
};