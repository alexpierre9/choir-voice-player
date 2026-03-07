import { pgTable, pgEnum, varchar, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

// Enums (must be declared before tables in Postgres)
export const loginMethodEnum = pgEnum('login_method', ['passphrase'])
export const roleEnum = pgEnum('role', ['user', 'admin'])
export const fileTypeEnum = pgEnum('file_type', ['pdf', 'musicxml'])
export const sheetStatusEnum = pgEnum('sheet_status', ['uploading', 'processing', 'ready', 'error'])

/**
 * Core user table backing auth flow.
 */
export const users = pgTable('users', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  loginMethod: loginMethodEnum('login_method'),
  role: roleEnum('role').default('user'),
  createdAt: timestamp('created_at').defaultNow(),
  lastSignedIn: timestamp('last_signed_in'),
})

export type User = typeof users.$inferSelect
export type InsertUser = typeof users.$inferInsert
export type SafeUser = User

/**
 * Sheet music uploads and processing results
 */
export const sheetMusic = pgTable('sheet_music', {
  id: varchar('id', { length: 64 }).primaryKey(),
  userId: varchar('user_id', { length: 64 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 255 }),
  originalFilename: varchar('original_filename', { length: 255 }),
  fileType: fileTypeEnum('file_type'),

  // Storage keys
  originalFileKey: text('original_file_key'),
  musicxmlKey: text('musicxml_key'),

  // Processing status
  status: sheetStatusEnum('status').default('uploading'),
  errorMessage: text('error_message'),

  // Analysis results (JSON)
  // Structure: { parts: [{ index, name, clef, pitch_range, detected_voice, note_count }], total_parts }
  analysisResult: jsonb('analysis_result'),

  // Voice assignments (JSON)
  // Structure: { "0": "soprano", "1": "alto", ... }
  voiceAssignments: jsonb('voice_assignments'),

  // MIDI file keys (JSON)
  // Structure: { "soprano": "s3-key", "alto": "s3-key", ... }
  midiFileKeys: jsonb('midi_file_keys'),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow().$onUpdate(() => new Date()),
}, (table) => {
  return {
    userIdIdx: index('idx_user_id').on(table.userId),
    statusIdx: index('idx_status').on(table.status),
    userIdStatusIdx: index('idx_user_id_status').on(table.userId, table.status),
    userIdCreatedAtIdx: index('idx_user_id_created_at').on(table.userId, table.createdAt),
  }
})

export type SheetMusic = typeof sheetMusic.$inferSelect
export type InsertSheetMusic = typeof sheetMusic.$inferInsert

/**
 * Key-value settings table for runtime configuration (e.g. Gemini API key).
 */
export const appSettings = pgTable('app_settings', {
  key: varchar('key', { length: 255 }).primaryKey(),
  value: text('value'),
  updatedAt: timestamp('updated_at').defaultNow().$onUpdate(() => new Date()),
})
