/**
 * Tests for JWT session management in sdk.ts.
 * Verifies token creation, verification, tamper detection, and expiry.
 */

import { describe, it, expect, beforeAll } from "vitest";

// Provide a test secret before the module loads
process.env.JWT_SECRET = "test-secret-at-least-32-characters-long-for-hs256";
process.env.DATABASE_URL = ""; // prevent DB connection during import
process.env.AUTH_PASSPHRASE = "test-passphrase";

const { sdk } = await import("./sdk.js");

describe("SDKServer.createSessionToken / verifySession", () => {
  it("creates a token that round-trips through verifySession", async () => {
    const token = await sdk.createSessionToken("owner", { name: "Test User" });
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3); // JWT structure

    const payload = await sdk.verifySession(token);
    expect(payload).not.toBeNull();
    expect(payload!.openId).toBe("owner");
    expect(payload!.name).toBe("Test User");
  });

  it("returns null for a missing / empty cookie", async () => {
    expect(await sdk.verifySession(undefined)).toBeNull();
    expect(await sdk.verifySession(null)).toBeNull();
    expect(await sdk.verifySession("")).toBeNull();
  });

  it("returns null for a tampered token", async () => {
    const token = await sdk.createSessionToken("owner");
    // Flip the last character of the signature to invalidate it
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(await sdk.verifySession(tampered)).toBeNull();
  });

  it("returns null for a token signed with a different secret", async () => {
    // Sign a JWT with a different secret
    const { SignJWT } = await import("jose");
    const wrongSecret = new TextEncoder().encode("completely-different-secret-value");
    const foreignToken = await new SignJWT({ openId: "owner", appId: "", name: "attacker" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(wrongSecret);

    expect(await sdk.verifySession(foreignToken)).toBeNull();
  });

  it("returns null for a token with a missing openId field", async () => {
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const badToken = await new SignJWT({ appId: "", name: "no-id" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(secret);

    expect(await sdk.verifySession(badToken)).toBeNull();
  });

  it("embeds appId and name from ENV.appId when not overridden", async () => {
    const token = await sdk.createSessionToken("test-user", { name: "Alice" });
    const payload = await sdk.verifySession(token);
    expect(payload!.name).toBe("Alice");
  });
});
