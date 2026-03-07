import { and, desc, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { InsertUser, SafeUser, users, sheetMusic, InsertSheetMusic, SheetMusic, appSettings } from "../drizzle/schema.js";
import { inArray } from "drizzle-orm";
import * as schema from "../drizzle/schema.js";

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
let _client: ReturnType<typeof postgres> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _client = postgres(process.env.DATABASE_URL);
      _db = drizzle(_client, { schema });
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function closeDb() {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
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

    await db.insert(users).values(values).onConflictDoUpdate({
      target: users.id,
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

  await db.insert(sheetMusic).values(data);
  const result = await db.select().from(sheetMusic).where(eq(sheetMusic.id, data.id!)).limit(1);
  return result[0];
}

export async function updateSheetMusic(id: string, data: Partial<InsertSheetMusic>): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  await db.update(sheetMusic).set(data).where(eq(sheetMusic.id, id));
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

  await db.delete(sheetMusic).where(eq(sheetMusic.id, id));
}

// App Settings helpers

export async function getAppSetting(key: string): Promise<string | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  try {
    const result = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
    return result.length > 0 ? result[0].value ?? undefined : undefined;
  } catch (err: any) {
    // Postgres error code 42P01 = undefined_table
    if (err?.code === '42P01') return undefined;
    throw err;
  }
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({
    target: appSettings.key,
    set: { value },
  });
}

export async function deleteAppSetting(key: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(appSettings).where(eq(appSettings.key, key));
}

export async function getAppSettings(keys: string[]): Promise<Record<string, string>> {
  const db = await getDb();
  if (!db) return {};
  if (keys.length === 0) return {};
  try {
    const rows = await db.select().from(appSettings).where(inArray(appSettings.key, keys));
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (row.value !== null && row.value !== undefined) {
        result[row.key] = row.value;
      }
    }
    return result;
  } catch (err: any) {
    // Postgres error code 42P01 = undefined_table — migration not applied yet
    if (err?.code === '42P01') {
      console.warn("[Database] app_settings table not found — run `pnpm db:push` to apply migrations");
      return {};
    }
    throw err;
  }
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
    )
    .returning({ id: sheetMusic.id });

  return result.length;
}
