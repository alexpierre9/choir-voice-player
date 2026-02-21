import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import { parse as parseCookieHeader } from "cookie";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";
import fetch from "node-fetch";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

/** Cookie name used to store the one-time CSRF nonce before the OAuth redirect. */
const OAUTH_NONCE_COOKIE = "oauth_nonce";

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error("[OAuth] GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not configured.");
}

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

function parseCookies(req: Request): Map<string, string> {
  const header = req.headers.cookie;
  if (!header) return new Map();
  const parsed = parseCookieHeader(header);
  return new Map(Object.entries(parsed));
}

/**
 * Ensures the post-login destination is a safe relative path.
 * Rejects anything that could be an external redirect (e.g. "//evil.com").
 */
function getSafeRedirectPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const stateRaw = getQueryParam(req, "state");

    if (!code || !stateRaw) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    // Always clear the nonce cookie when this route is hit (success or failure).
    res.clearCookie(OAUTH_NONCE_COOKIE, { path: "/" });

    try {
      // Decode state — expect JSON { nonce, redirectTo, redirectUri }
      let stateObj: { nonce?: string; redirectTo?: string; redirectUri?: string };
      try {
        stateObj = JSON.parse(Buffer.from(stateRaw, "base64").toString("utf-8"));
      } catch {
        throw new Error("Malformed state parameter");
      }

      const { nonce, redirectTo, redirectUri } = stateObj;

      // CSRF check: the nonce in the URL state must match the one stored in the
      // short-lived cookie set by the client before initiating the OAuth flow.
      const cookies = parseCookies(req);
      const nonceCookie = cookies.get(OAUTH_NONCE_COOKIE);
      if (!nonce || !nonceCookie || nonce !== nonceCookie) {
        console.warn("[OAuth] CSRF check failed: nonce mismatch");
        res.redirect(302, "/?auth_error=csrf");
        return;
      }

      // Validate the redirect_uri ends with our expected callback path so it
      // can't be pointed at an external domain.
      if (!redirectUri || !redirectUri.endsWith("/api/oauth/callback")) {
        throw new Error("Invalid redirect_uri in state");
      }

      // Exchange authorization code for tokens
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`Google token exchange failed: ${err}`);
      }

      const tokens = await tokenRes.json() as { access_token: string };

      // Fetch user profile from Google
      const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });

      if (!userRes.ok) {
        throw new Error("Failed to fetch user info from Google");
      }

      const userInfo = await userRes.json() as {
        sub: string;
        name?: string;
        email?: string;
        email_verified?: boolean;
        picture?: string;
      };

      if (!userInfo.sub) {
        res.redirect(302, "/?auth_error=missing_sub");
        return;
      }

      // Reject unverified email addresses — avoids account takeover via
      // unverified Gmail aliases.
      if (userInfo.email && userInfo.email_verified === false) {
        res.redirect(302, "/?auth_error=email_not_verified");
        return;
      }

      await db.upsertUser({
        id: userInfo.sub,
        name: userInfo.name ?? null,
        email: userInfo.email ?? null,
        loginMethod: "google",
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(userInfo.sub, {
        name: userInfo.name ?? "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      // Redirect the user back to the page they were on before signing in.
      const safeRedirect = getSafeRedirectPath(redirectTo);
      res.redirect(302, safeRedirect);
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.redirect(302, "/?auth_error=oauth_failed");
    }
  });
}
