import { and, desc, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, SafeUser, users, sheetMusic, InsertSheetMusic, SheetMusic } from "../drizzle/schema";

const safeUserFields = {
  id: users.id,
  name: users.name,
  email: users.email,
  loginMethod: users.loginMethod,
  role: users.role,
  createdAt: users.createdAt,
  lastSignedIn: users.lastSignedIn,
} as const;

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.id) {
    throw new Error("User ID is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      id: user.id,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

/** Get a user by ID. */
export async function getUser(id: string): Promise<SafeUser | undefined> {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db
    .select(safeUserFields)
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// Sheet Music Database Functions

export async function createSheetMusic(data: InsertSheetMusic): Promise<SheetMusic> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  return await db.transaction(async (tx) => {
    await tx.insert(sheetMusic).values(data);

    const result = await tx.select().from(sheetMusic).where(eq(sheetMusic.id, data.id!)).limit(1);
    return result[0];
  });
}

export async function updateSheetMusic(id: string, data: Partial<InsertSheetMusic>): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  await db.transaction(async (tx) => {
    await tx.update(sheetMusic).set(data).where(eq(sheetMusic.id, id));
  });
}

export async function getSheetMusic(id: string): Promise<SheetMusic | undefined> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const result = await db.select().from(sheetMusic).where(eq(sheetMusic.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserSheetMusic(userId: string): Promise<SheetMusic[]> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  return await db
    .select()
    .from(sheetMusic)
    .where(eq(sheetMusic.userId, userId))
    .orderBy(desc(sheetMusic.createdAt));
}

export async function deleteSheetMusic(id: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  await db.transaction(async (tx) => {
    await tx.delete(sheetMusic).where(eq(sheetMusic.id, id));
  });
}

/** Mark any sheet stuck in "processing" for more than `thresholdMs` ms as errored. */
export async function markStaleProcessingSheets(thresholdMs = 5 * 60 * 1000): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const cutoff = new Date(Date.now() - thresholdMs);

  const result = await db
    .update(sheetMusic)
    .set({
      status: "error",
      errorMessage: "Processing timed out. Please retry.",
    })
    .where(
      and(
        eq(sheetMusic.status, "processing"),
        lt(sheetMusic.updatedAt, cutoff)
      )
    );

  return (result as any)[0]?.affectedRows ?? 0;
}
