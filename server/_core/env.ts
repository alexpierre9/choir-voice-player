export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  authPassphrase: process.env.AUTH_PASSPHRASE ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  // B-10: shared secret sent to the Python service so it can reject
  // requests that don't come from this server.
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN ?? "",
};

/** Call at startup. Logs and exits if critical env vars are missing. */
export function validateEnv(): void {
  const missing: string[] = [];
  if (!ENV.cookieSecret) missing.push("JWT_SECRET");
  if (!ENV.authPassphrase) missing.push("AUTH_PASSPHRASE");
  if (!ENV.databaseUrl) missing.push("DATABASE_URL");

  if (missing.length > 0) {
    console.error(`[FATAL] Missing required environment variables: ${missing.join(", ")}`);
    console.error("[FATAL] Set these in your .env file and restart the server.");
    process.exit(1);
  }

  // Non-fatal warnings for optional-but-recommended production settings
  if (!ENV.internalServiceToken && ENV.isProduction) {
    console.warn(
      "[WARN] INTERNAL_SERVICE_TOKEN is not set. " +
      "The Python processing service accepts requests from any caller. " +
      "Set this variable to a random secret (openssl rand -hex 32) in production."
    );
  }
}
