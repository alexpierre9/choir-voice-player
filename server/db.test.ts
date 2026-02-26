/**
 * Tests for database helper functions.
 * Mocks drizzle-orm/mysql2 so no real MySQL connection is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- mock drizzle-orm/mysql2 so no real DB connection is opened ----

// Build a fake drizzle chainable query builder
const mockWhereResult = vi.fn();
const mockSetChain = vi.fn().mockReturnValue({ where: mockWhereResult });
const mockUpdateChain = vi.fn().mockReturnValue({ set: mockSetChain });

const mockOnDupChain = vi.fn();
const mockValuesChain = vi.fn().mockReturnValue({ onDuplicateKeyUpdate: mockOnDupChain });
const mockInsertChain = vi.fn().mockReturnValue({ values: mockValuesChain });

const fakeDb = {
  update: mockUpdateChain,
  insert: mockInsertChain,
};

vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: vi.fn(() => fakeDb),
}));

// Provide required env vars before importing the module
process.env.DATABASE_URL = "mysql://test:test@localhost:3306/test";
process.env.JWT_SECRET = "test-secret-at-least-32-characters-long-for-hs256";
process.env.AUTH_PASSPHRASE = "test";

const { markStaleProcessingSheets, upsertUser } = await import("./db.js");

describe("markStaleProcessingSheets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set chain mocks after clearAllMocks (clearAllMocks resets return values)
    mockSetChain.mockReturnValue({ where: mockWhereResult });
    mockUpdateChain.mockReturnValue({ set: mockSetChain });
    mockValuesChain.mockReturnValue({ onDuplicateKeyUpdate: mockOnDupChain });
    mockInsertChain.mockReturnValue({ values: mockValuesChain });
  });

  it("returns 0 when no sheets are stale (0 affected rows)", async () => {
    mockWhereResult.mockResolvedValue([{ affectedRows: 0 }]);
    const count = await markStaleProcessingSheets();
    expect(count).toBe(0);
  });

  it("returns the number of affected rows when sheets are marked", async () => {
    mockWhereResult.mockResolvedValue([{ affectedRows: 3 }]);
    const count = await markStaleProcessingSheets();
    expect(count).toBe(3);
  });

  it("calls the DB update with status='error'", async () => {
    mockWhereResult.mockResolvedValue([{ affectedRows: 1 }]);
    await markStaleProcessingSheets();

    // Verify update was called once
    expect(mockUpdateChain).toHaveBeenCalledTimes(1);

    // Verify .set() was called with status='error' and an error message
    const setCalls = mockSetChain.mock.calls;
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0][0]).toMatchObject({
      status: "error",
      errorMessage: expect.stringContaining("timed out"),
    });
  });

  it("handles missing affectedRows gracefully (returns 0)", async () => {
    mockWhereResult.mockResolvedValue([{}]); // no affectedRows key
    const count = await markStaleProcessingSheets();
    expect(count).toBe(0);
  });
});

describe("upsertUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValuesChain.mockReturnValue({ onDuplicateKeyUpdate: mockOnDupChain });
    mockInsertChain.mockReturnValue({ values: mockValuesChain });
    mockOnDupChain.mockResolvedValue(undefined);
  });

  it("throws when no id is provided", async () => {
    await expect(upsertUser({ id: "" })).rejects.toThrow(/id is required/i);
  });

  it("calls DB insert with id and name", async () => {
    await upsertUser({
      id: "owner",
      name: "Owner",
      loginMethod: "passphrase",
      lastSignedIn: new Date("2024-01-01"),
    });

    expect(mockInsertChain).toHaveBeenCalledTimes(1);

    const insertedValues = mockValuesChain.mock.calls[0]?.[0];
    expect(insertedValues).toMatchObject({ id: "owner", name: "Owner" });
  });

  it("includes onDuplicateKeyUpdate to handle re-login", async () => {
    await upsertUser({ id: "owner", name: "Owner" });

    // The chain must end with onDuplicateKeyUpdate (upsert semantics)
    expect(mockOnDupChain).toHaveBeenCalledTimes(1);
    const updateSet = mockOnDupChain.mock.calls[0]?.[0]?.set;
    expect(updateSet).toBeDefined();
    expect(updateSet).toHaveProperty("name");
  });
});
