export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  authPassphrase: process.env.AUTH_PASSPHRASE ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
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
}
