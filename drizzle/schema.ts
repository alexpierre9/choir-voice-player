import { mysqlEnum, mysqlTable, text, timestamp, varchar, int, json, index, uniqueIndex } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  /** bcrypt hash — only set for email+password accounts. */
  passwordHash: varchar("passwordHash", { length: 255 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow(),
}, (table) => ({
  emailUniqueIdx: uniqueIndex("users_email_unique").on(table.email),
}));

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Sheet music uploads and processing results
 */
export const sheetMusic = mysqlTable("sheet_music", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: varchar("userId", { length: 64 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  originalFilename: varchar("originalFilename", { length: 255 }).notNull(),
  fileType: mysqlEnum("fileType", ["pdf", "musicxml"]).notNull(),

  // S3 storage keys
  originalFileKey: varchar("originalFileKey", { length: 512 }),
  musicxmlKey: varchar("musicxmlKey", { length: 512 }),

  // Processing status
  status: mysqlEnum("status", ["uploading", "processing", "ready", "error"]).default("uploading").notNull(),
  errorMessage: text("errorMessage"),

  // Analysis results (JSON)
  // Structure: { parts: [{ index, name, clef, pitch_range, detected_voice, note_count }], total_parts }
  analysisResult: json("analysisResult"),

  // Voice assignments (JSON)
  // Structure: { "0": "soprano", "1": "alto", ... }
  voiceAssignments: json("voiceAssignments"),

  // MIDI file keys (JSON)
  // Structure: { "soprano": "s3-key", "alto": "s3-key", ... }
  midiFileKeys: json("midiFileKeys"),

  createdAt: timestamp("createdAt").defaultNow(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow(),
}, (table) => {
  return {
    userIdIdx: index("idx_user_id").on(table.userId),
    statusIdx: index("idx_status").on(table.status),
    userIdStatusIdx: index("idx_user_id_status").on(table.userId, table.status),
  };
});

export type SheetMusic = typeof sheetMusic.$inferSelect;
export type InsertSheetMusic = typeof sheetMusic.$inferInsert;

