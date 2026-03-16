import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { ENV } from "./_core/env";
import { logger } from "./_core/logger";
import { sdk } from "./_core/sdk";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { timingSafeEqual } from "crypto";
import {
  createSheetMusic,
  updateSheetMusic,
  getSheetMusic,
  getUserSheetMusic,
  deleteSheetMusic,
  upsertUser,
  getAppSetting,
  setAppSetting,
  deleteAppSetting,
  getAppSettings,
} from "./db";
import { storagePut, storageGet, storageDelete } from "./storage-active";
import { emitProcessingEvent } from "./sse";
import FormData from "form-data";
import fetch from "node-fetch";
import fs from "fs/promises";

// Python service URL
const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || "http://localhost:8001";

// B-10: Internal auth header sent on every request to the Python service.
// When INTERNAL_SERVICE_TOKEN is set, the Python service will reject calls
// that don't carry this header, preventing unauthenticated direct access.
const INTERNAL_TOKEN_HEADER: Record<string, string> = ENV.internalServiceToken
  ? { "X-Internal-Token": ENV.internalServiceToken }
  : {};

// Per-sheet lock to prevent concurrent MIDI generation.
// Each entry chains promises so only one regeneration runs at a time per sheet.
const midiGenerationLocks = new Map<string, Promise<void>>();

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),

    login: publicProcedure
      .input(z.object({ passphrase: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const expected = ENV.authPassphrase;
        if (!expected) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Server authentication is not configured.",
          });
        }

        // Timing-safe comparison to prevent side-channel leaks.
        const a = Buffer.from(input.passphrase);
        const b = Buffer.from(expected);
        const valid = a.length === b.length && timingSafeEqual(a, b);

        if (!valid) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Invalid passphrase.",
          });
        }

        // Ensure a single "owner" user row exists for foreign-key integrity.
        const OWNER_ID = "owner";
        try {
          await upsertUser({
            id: OWNER_ID,
            name: "Owner",
            loginMethod: "passphrase",
            lastSignedIn: new Date(),
          });
        } catch (dbErr: unknown) {
          // Log the underlying MySQL error (hidden in DrizzleError.cause) for debugging.
          const cause = (dbErr as any)?.cause ?? dbErr;
          logger.error("upsertUser failed during login", { err: String(cause) });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Sign-in failed due to a database error. Run `pnpm db:push` to ensure the schema is up to date, then try again.",
          });
        }

        const sessionToken = await sdk.createSessionToken(OWNER_ID, {
          name: "Owner",
          expiresInMs: ONE_YEAR_MS,
        });

        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, sessionToken, {
          ...cookieOptions,
          maxAge: ONE_YEAR_MS,
        });

        return { success: true } as const;
      }),

    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  sheetMusic: router({
    /**
     * @deprecated Use POST /api/upload (multipart FormData) instead.
     * This tRPC procedure sends file data as base64 JSON, which is ~33% larger
     * and requires buffering the entire file in memory on the client before sending.
     * Kept for backward compatibility only.
     */
    upload: protectedProcedure
      .input(z.object({
        filename: z.string(),
        fileType: z.enum(["pdf", "musicxml"]),
        fileData: z.string(), // base64 encoded
        title: z.string().trim().max(255).optional(), // B-13: trim whitespace
      }))
      .mutation(async ({ ctx, input }) => {
        const userId = ctx.user.id;
        const sheetId = nanoid();

        // Decode file data
        const fileBuffer = Buffer.from(input.fileData, 'base64');

        // B-08: return 400 (BAD_REQUEST) instead of an opaque 500
        const maxSize = 50 * 1024 * 1024; // 50 MB
        if (fileBuffer.length > maxSize) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `File size exceeds the maximum allowed size of ${maxSize / (1024 * 1024)} MB`,
          });
        }

        logger.info("Sheet music upload", {
          sheetId,
          userId,
          filename: input.filename,
          fileType: input.fileType,
          sizeBytes: fileBuffer.length,
        });

        // Save original file to local storage
        const fileExtension = input.fileType === "pdf" ? "pdf" : "musicxml";
        const originalFileKey = `sheet-music/${userId}/${sheetId}/original.${fileExtension}`;

        const { key: uploadedKey } = await storagePut(
          originalFileKey,
          fileBuffer,
          input.fileType === "pdf" ? "application/pdf" : "application/xml"
        );

        // Create database record
        const title = input.title || input.filename.replace(/\.[^/.]+$/, "");

        await createSheetMusic({
          id: sheetId,
          userId,
          title,
          originalFilename: input.filename,
          fileType: input.fileType,
          originalFileKey: uploadedKey,
          status: "processing",
        });

        // B-14: pass userId so the async pipeline doesn't need an extra DB round-trip
        processSheetMusicAsync(sheetId, userId, fileBuffer, input.fileType).catch(async err => {
          logger.error("Failed to process sheet music", { sheetId, err: String(err) });
          try {
            await updateSheetMusic(sheetId, {
              status: "error",
              errorMessage: err.message,
            });
          } catch (updateErr) {
            logger.error("Failed to update error status", { sheetId, err: String(updateErr) });
          }
        });

        return {
          id: sheetId,
          status: "processing",
        };
      }),

    // Get sheet music by ID
    get: protectedProcedure
      .input(z.object({ id: z.string().min(1).max(64) })) // B-09: length validation
      .query(async ({ ctx, input }) => {
        const sheet = await getSheetMusic(input.id);

        // B-03: use TRPCError with proper codes — NOT raw Error (which becomes HTTP 500)
        if (!sheet) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Sheet music not found" });
        }

        if (sheet.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Unauthorized" });
        }

        return sheet;
      }),

    // Rename sheet music
    rename: protectedProcedure
      .input(z.object({
        id: z.string().min(1).max(64),              // B-09
        title: z.string().trim().min(1).max(255),   // B-13: trim whitespace
      }))
      .mutation(async ({ ctx, input }) => {
        const sheet = await getSheetMusic(input.id);
        // B-03: TRPCError
        if (!sheet) throw new TRPCError({ code: "NOT_FOUND", message: "Sheet music not found" });
        if (sheet.userId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Unauthorized" });
        await updateSheetMusic(input.id, { title: input.title });
        return { success: true };
      }),

    // List user's sheet music
    list: protectedProcedure
      .query(async ({ ctx }) => {
        return await getUserSheetMusic(ctx.user.id);
      }),

    // Update voice assignments and regenerate MIDI
    updateVoiceAssignments: protectedProcedure
      .input(z.object({
        id: z.string().min(1).max(64), // B-09
        voiceAssignments: z.record(z.string(), z.enum(["soprano", "alto", "tenor", "bass", "other"])),
      }))
      .mutation(async ({ ctx, input }) => {
        const sheet = await getSheetMusic(input.id);

        // B-03: TRPCError with proper codes
        if (!sheet) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Sheet music not found" });
        }

        if (sheet.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Unauthorized" });
        }

        logger.info("Voice assignments updated", {
          sheetId: input.id,
          userId: ctx.user.id,
          oldAssignments: sheet.voiceAssignments,
          newAssignments: input.voiceAssignments,
        });

        // Update voice assignments, set status back to processing, clear stale MIDI keys
        await updateSheetMusic(input.id, {
          voiceAssignments: input.voiceAssignments as any,
          status: "processing",
          midiFileKeys: null,
        });

        // Regenerate MIDI files
        if (sheet.musicxmlKey) {
          enqueueMidiRegeneration(sheet.userId, input.id, sheet.musicxmlKey, input.voiceAssignments)
            .then(() => updateSheetMusic(input.id, { status: "ready" }))
            .catch(async (err) => {
              logger.error("Failed to regenerate MIDI", { sheetId: input.id, err: String(err) });
              await updateSheetMusic(input.id, {
                status: "error",
                errorMessage: err instanceof Error ? err.message : "MIDI regeneration failed",
              }).catch(() => {});
            });
        }

        return { success: true };
      }),

    // Update MusicXML from notation editor and re-analyze
    updateMusicXML: protectedProcedure
      .input(z.object({
        id: z.string().min(1).max(64),
        musicxml: z.string().min(1),
      }))
      .mutation(async ({ input, ctx }) => {
        const sheet = await getSheetMusic(input.id);

        if (!sheet) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Sheet not found" });
        }
        if (sheet.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Not your sheet" });
        }

        const sheetId = input.id;
        const userId = ctx.user.id;

        // Store updated MusicXML
        const musicxmlKey = `sheet-music/${userId}/${sheetId}/score.musicxml`;
        const musicxmlBuffer = Buffer.from(input.musicxml, "utf-8");
        await storagePut(musicxmlKey, musicxmlBuffer, "application/xml");

        // Set status to processing
        emitProcessingEvent(sheetId, "processing_step", { step: "Re-analyzing edited score..." });

        await updateSheetMusic(sheetId, {
          status: "processing",
          musicxmlKey,
          errorMessage: null,
          midiFileKeys: null,
        });

        // Re-analyze via Python service
        const formData = new FormData();
        formData.append("file", musicxmlBuffer, {
          filename: "score.musicxml",
          contentType: "application/xml",
        });

        const pyUrl = `${PYTHON_SERVICE_URL}/api/process-musicxml`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60_000);
        const startTime = Date.now();
        const pyRes = await fetch(pyUrl, {
          method: "POST",
          body: formData as any,
          headers: {
            ...formData.getHeaders(),
            ...INTERNAL_TOKEN_HEADER,
          },
          signal: controller.signal as any,
        });
        clearTimeout(timeoutId);
        logger.info("Python service call (updateMusicXML)", {
          endpoint: "/api/process-musicxml",
          durationMs: Date.now() - startTime,
          status: pyRes.status,
        });

        if (!pyRes.ok) {
          const errorText = await pyRes.text();
          const errMsg = parsePythonError(errorText);
          await updateSheetMusic(sheetId, { status: "error", errorMessage: errMsg });
          emitProcessingEvent(sheetId, "status_changed", { status: "error", errorMessage: errMsg });
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: errMsg });
        }

        const result = await pyRes.json() as {
          success: boolean;
          analysis: any;
          warnings?: string[];
        };
        const analysis = result.analysis;

        // Update voice assignments from re-analysis
        const voiceAssignments: Record<string, string> = {};
        if (analysis?.parts) {
          for (const part of analysis.parts) {
            voiceAssignments[String(part.index)] = part.detected_voice || "other";
          }
        }

        await updateSheetMusic(sheetId, {
          musicxmlKey,
          analysisResult: { ...analysis, warnings: result.warnings || [] },
          voiceAssignments,
          errorMessage: "Generating MIDI files…",
        });

        // Regenerate MIDI
        emitProcessingEvent(sheetId, "processing_step", { step: "Generating MIDI files..." });

        enqueueMidiRegeneration(userId, sheetId, musicxmlKey, voiceAssignments)
          .then(() => {
            updateSheetMusic(sheetId, { status: "ready", errorMessage: null });
            emitProcessingEvent(sheetId, "status_changed", { status: "ready" });
          })
          .catch(async (err) => {
            logger.error("Failed to regenerate MIDI after MusicXML update", { sheetId, err: String(err) });
            await updateSheetMusic(sheetId, {
              status: "error",
              errorMessage: err instanceof Error ? err.message : "MIDI regeneration failed",
            }).catch(() => {});
            emitProcessingEvent(sheetId, "status_changed", {
              status: "error",
              errorMessage: err instanceof Error ? err.message : "MIDI regeneration failed",
            });
          });

        return { success: true };
      }),

    // Get MIDI file URL
    getMidiUrl: protectedProcedure
      .input(z.object({
        id: z.string().min(1).max(64), // B-09
        voice: z.string(),
      }))
      .query(async ({ ctx, input }) => {
        const sheet = await getSheetMusic(input.id);

        // B-03: TRPCError with proper codes
        if (!sheet) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Sheet music not found" });
        }

        if (sheet.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Unauthorized" });
        }

        if (!sheet.midiFileKeys) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "MIDI files not generated yet" });
        }

        const midiKeys = sheet.midiFileKeys as Record<string, string>;
        const midiKey = midiKeys[input.voice] ?? midiKeys["all"];

        if (!midiKey) {
          throw new TRPCError({ code: "NOT_FOUND", message: `MIDI file for voice "${input.voice}" not found` });
        }

        // Generate presigned URL (5 minutes)
        const { url } = await storageGet(midiKey, 300);

        return { url };
      }),

    // Delete sheet music
    delete: protectedProcedure
      .input(z.object({ id: z.string().min(1).max(64) })) // B-09
      .mutation(async ({ ctx, input }) => {
        const sheet = await getSheetMusic(input.id);

        // B-03: TRPCError with proper codes
        if (!sheet) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Sheet music not found" });
        }

        if (sheet.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Unauthorized" });
        }

        // Delete storage files asynchronously (don't block on individual failures)
        const deletePromises: Promise<void>[] = [];

        if (sheet.originalFileKey) {
          deletePromises.push(
            storageDelete(sheet.originalFileKey).catch(err => {
              logger.warn("Failed to delete original file", { key: sheet.originalFileKey, err: String(err) });
            })
          );
        }

        if (sheet.musicxmlKey) {
          deletePromises.push(
            storageDelete(sheet.musicxmlKey).catch(err => {
              logger.warn("Failed to delete musicxml", { key: sheet.musicxmlKey, err: String(err) });
            })
          );
        }

        if (sheet.midiFileKeys) {
          const midiKeys = sheet.midiFileKeys as Record<string, string>;
          for (const voiceType of Object.keys(midiKeys)) {
            const midiKey = midiKeys[voiceType];
            if (midiKey) {
              deletePromises.push(
                storageDelete(midiKey).catch(err => {
                  logger.warn("Failed to delete midi file", { key: midiKey, err: String(err) });
                })
              );
            }
          }
        }

        await Promise.all(deletePromises);

        await deleteSheetMusic(input.id);

        return { success: true };
      }),

    // Bulk delete sheet music
    deleteMany: protectedProcedure
      .input(
        z.object({
          ids: z.array(z.string().min(1).max(64)).min(1).max(50),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const results = await Promise.allSettled(
          input.ids.map(async (id) => {
            const sheet = await getSheetMusic(id);
            if (!sheet || sheet.userId !== ctx.user.id) return;

            const deletePromises: Promise<void>[] = [];
            if (sheet.originalFileKey) {
              deletePromises.push(
                storageDelete(sheet.originalFileKey).catch((err) => {
                  logger.warn("Failed to delete original file", {
                    key: sheet.originalFileKey,
                    err: String(err),
                  });
                }),
              );
            }
            if (sheet.musicxmlKey) {
              deletePromises.push(
                storageDelete(sheet.musicxmlKey).catch((err) => {
                  logger.warn("Failed to delete musicxml", {
                    key: sheet.musicxmlKey,
                    err: String(err),
                  });
                }),
              );
            }
            if (sheet.midiFileKeys) {
              const midiKeys = sheet.midiFileKeys as Record<string, string>;
              for (const key of Object.values(midiKeys)) {
                if (key) {
                  deletePromises.push(
                    storageDelete(key).catch((err) => {
                      logger.warn("Failed to delete midi file", {
                        key,
                        err: String(err),
                      });
                    }),
                  );
                }
              }
            }
            await Promise.all(deletePromises);
            await deleteSheetMusic(id);
          }),
        );

        const deleted = results.filter((r) => r.status === "fulfilled").length;
        return { deleted, total: input.ids.length };
      }),

    // Retry failed processing (resets to the beginning of the pipeline)
    retry: protectedProcedure
      .input(z.object({ id: z.string().min(1).max(64) })) // B-09
      .mutation(async ({ ctx, input }) => {
        const sheet = await getSheetMusic(input.id);

        if (!sheet) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Sheet music not found" });
        }

        if (sheet.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Unauthorized" });
        }

        if (sheet.status !== "error") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Sheet music is not in an error state" });
        }

        if (!sheet.originalFileKey) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Original file not found; cannot retry" });
        }

        // B-07: handle both local storage (filePath) and cloud storage (url) adapters
        const storageResult = await storageGet(sheet.originalFileKey, 300);
        let fileBuffer: Buffer;
        if ('filePath' in storageResult && storageResult.filePath) {
          fileBuffer = await fs.readFile(storageResult.filePath);
        } else {
          const fileRes = await fetch(storageResult.url);
          if (!fileRes.ok) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to fetch original file from storage.",
            });
          }
          fileBuffer = Buffer.from(await fileRes.arrayBuffer());
        }

        // Reset to processing state
        await updateSheetMusic(input.id, {
          status: "processing",
          errorMessage: null,
          musicxmlKey: null,
          analysisResult: null,
          voiceAssignments: null,
          midiFileKeys: null,
        });

        // B-14: pass userId directly — no extra DB round-trip needed
        processSheetMusicAsync(input.id, sheet.userId, fileBuffer, sheet.fileType).catch(async err => {
          logger.error("Failed to retry processing", { sheetId: input.id, err: String(err) });
          try {
            await updateSheetMusic(input.id, {
              status: "error",
              errorMessage: err.message,
            });
          } catch (updateErr) {
            logger.error("Failed to update error status on retry", { sheetId: input.id, err: String(updateErr) });
          }
        });

        return { success: true };
      }),
  }),

  settings: router({
    getGeminiConfig: protectedProcedure.query(async () => {
      const settings = await getAppSettings([
        "gemini_api_key",
        "gemini_model_name",
        "gemini_max_output_tokens",
      ]);

      const dbKeySet = !!settings.gemini_api_key;
      const envKeySet = !!process.env.GEMINI_API_KEY;

      return {
        apiKeySet: dbKeySet || envKeySet,
        apiKeySource: dbKeySet ? "database" as const : envKeySet ? "environment" as const : "none" as const,
        modelName: settings.gemini_model_name || process.env.GEMINI_MODEL_NAME || "gemini-2.0-flash",
        maxOutputTokens: settings.gemini_max_output_tokens
          ? parseInt(settings.gemini_max_output_tokens, 10)
          : parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || "8192", 10),
      };
    }),

    updateGeminiConfig: protectedProcedure
      .input(z.object({
        apiKey: z.string().optional(),
        modelName: z.string().trim().min(1).max(255).optional(),
        maxOutputTokens: z.number().int().min(1024).max(65536).optional(),
      }))
      .mutation(async ({ input }) => {
        const pythonPayload: Record<string, unknown> = {};

        if (input.apiKey !== undefined) {
          if (input.apiKey === "") {
            await deleteAppSetting("gemini_api_key");
            // Revert to env var if present
            pythonPayload.gemini_api_key = process.env.GEMINI_API_KEY || "";
          } else {
            await setAppSetting("gemini_api_key", input.apiKey);
            pythonPayload.gemini_api_key = input.apiKey;
          }
        }

        if (input.modelName !== undefined) {
          await setAppSetting("gemini_model_name", input.modelName);
          pythonPayload.gemini_model_name = input.modelName;
        }

        if (input.maxOutputTokens !== undefined) {
          await setAppSetting("gemini_max_output_tokens", String(input.maxOutputTokens));
          pythonPayload.gemini_max_output_tokens = input.maxOutputTokens;
        }

        // Push updated config to the Python service (best-effort)
        if (Object.keys(pythonPayload).length > 0) {
          try {
            await fetch(`${PYTHON_SERVICE_URL}/api/update-config`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...INTERNAL_TOKEN_HEADER,
              },
              body: JSON.stringify(pythonPayload),
            });
          } catch (err) {
            logger.warn("Failed to push config to Python service", { err: String(err) });
          }
        }

        return { success: true };
      }),

    testGeminiConnection: protectedProcedure.mutation(async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`${PYTHON_SERVICE_URL}/api/test-gemini`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...INTERNAL_TOKEN_HEADER,
          },
          signal: controller.signal as any,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const errorText = await res.text();
          const message = parsePythonError(errorText);
          throw new TRPCError({ code: "BAD_REQUEST", message });
        }

        const result = await res.json() as { success: boolean; model?: string };
        return result;
      } catch (err: any) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err.message || "Failed to test Gemini connection",
        });
      }
    }),
  }),
});

export type AppRouter = typeof appRouter;

// Health check cache: success cached for 30 s, failure cached for 5 s so the
// service is re-checked quickly after it recovers.
let _healthCache: { ok: boolean; error?: string; expiresAt: number } | null = null;

// Check that the Python processing service is reachable (fast 2s timeout).
// Results are cached so concurrent uploads don't all hammer the /health endpoint.
async function checkPythonServiceHealth(): Promise<void> {
  if (_healthCache && Date.now() < _healthCache.expiresAt) {
    if (!_healthCache.ok) throw new Error(_healthCache.error);
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${PYTHON_SERVICE_URL}/health`, {
      signal: controller.signal as any,
    });
    if (!res.ok) {
      const msg = `Python service returned HTTP ${res.status}`;
      _healthCache = { ok: false, error: msg, expiresAt: Date.now() + 5_000 };
      throw new Error(msg);
    }
    _healthCache = { ok: true, expiresAt: Date.now() + 30_000 };
  } catch (err: any) {
    let msg: string;
    if (err.name === 'AbortError' || err.code === 'ECONNABORTED') {
      msg = 'Python processing service is not responding (timeout). Please try again later.';
    } else if (err.code === 'ECONNREFUSED') {
      msg = 'Python processing service is not running. Please contact the administrator.';
    } else if (_healthCache?.error === err.message) {
      // Already cached — just rethrow
      throw err;
    } else {
      msg = `Python processing service health check failed: ${err.message}`;
    }
    _healthCache = { ok: false, error: msg, expiresAt: Date.now() + 5_000 };
    throw new Error(msg, { cause: err });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse a structured error response from the Python service.
 * Python returns `{"error_category": "...", "error_message": "..."}` as the
 * HTTPException detail string.  Falls back to the raw text for old-format errors.
 */
function parsePythonError(errorText: string): string {
  try {
    // FastAPI wraps the detail in a {"detail": "..."} envelope
    const outer = JSON.parse(errorText);
    const detail = typeof outer?.detail === "string" ? outer.detail : errorText;
    const inner = JSON.parse(detail);
    if (inner?.error_message) return inner.error_message;
  } catch {
    // Not JSON or unexpected shape — fall through
  }
  // Strip the {"detail": "..."} wrapper if present but not structured
  try {
    const outer = JSON.parse(errorText);
    if (typeof outer?.detail === "string") return outer.detail;
  } catch {
    // Not JSON at all
  }
  return errorText;
}

// B-14: userId is now passed as a parameter to avoid a redundant DB round-trip
// inside the async pipeline (the upload/retry callers already have it).
export async function processSheetMusicAsync(
  sheetId: string,
  userId: string,
  fileBuffer: Buffer,
  fileType: "pdf" | "musicxml"
) {
  try {
    // Fail fast if the Python service is unreachable
    await checkPythonServiceHealth();

    const stepMsg = fileType === "pdf" ? "Running Audiveris OMR..." : "Parsing score…";
    emitProcessingEvent(sheetId, "processing_step", { step: stepMsg });

    await updateSheetMusic(sheetId, {
      errorMessage: stepMsg,
    });

    // Call Python service
    const formData = new FormData();
    formData.append('file', fileBuffer, {
      filename: `file.${fileType === "pdf" ? "pdf" : "musicxml"}`,
      contentType: fileType === "pdf" ? "application/pdf" : "application/xml",
    });

    const endpoint = fileType === "pdf" ? "/api/process-pdf" : "/api/process-musicxml";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 150000); // 150 s (> Gemini's 120 s timeout + overhead)
    const fetchStart = Date.now();
    const response = await fetch(`${PYTHON_SERVICE_URL}${endpoint}`, {
      method: 'POST',
      body: formData as any,
      headers: {
        ...formData.getHeaders(),
        ...INTERNAL_TOKEN_HEADER, // B-10: internal auth
      },
      signal: controller.signal as any,
    });
    clearTimeout(timeoutId);
    logger.info("Python service responded", {
      sheetId,
      endpoint,
      durationMs: Date.now() - fetchStart,
      status: response.status,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(parsePythonError(errorText));
    }

    const result = await response.json() as {
      success: boolean;
      musicxml: string;
      analysis: any;
      warnings?: string[];
    };

    if (!result.success) {
      throw new Error("Processing failed");
    }

    if (result.warnings?.length) {
      result.analysis.warnings = result.warnings;
    }

    emitProcessingEvent(sheetId, "processing_step", { step: "Storing score…" });
    await updateSheetMusic(sheetId, { errorMessage: "Storing score…" });

    // B-14: use userId parameter directly — no getSheetMusic() call needed
    const musicxmlKey = `sheet-music/${userId}/${sheetId}/score.musicxml`;
    await storagePut(musicxmlKey, result.musicxml, "application/xml");

    // Create initial voice assignments from analysis
    const voiceAssignments: Record<string, string> = {};
    for (const part of result.analysis.parts) {
      voiceAssignments[part.index.toString()] = part.detected_voice;
    }

    // Update database with analysis results (keep "processing" until MIDI is done)
    await updateSheetMusic(sheetId, {
      musicxmlKey,
      analysisResult: result.analysis,
      voiceAssignments,
      errorMessage: "Generating MIDI files…",
    });
    emitProcessingEvent(sheetId, "processing_step", { step: "Generating MIDI files…" });

    // Generate MIDI files, then set status to "ready"
    await enqueueMidiRegeneration(userId, sheetId, musicxmlKey, voiceAssignments);

    await updateSheetMusic(sheetId, { status: "ready", errorMessage: null });
    emitProcessingEvent(sheetId, "status_changed", { status: "ready" });

  } catch (error) {
    logger.error("Sheet processing pipeline failed", { sheetId, err: String(error) });
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    await updateSheetMusic(sheetId, {
      status: "error",
      errorMessage: errorMsg,
    });
    emitProcessingEvent(sheetId, "status_changed", {
      status: "error",
      errorMessage: errorMsg,
    });
  }
}

/**
 * Enqueue a MIDI regeneration for the given sheet. If a regeneration is already
 * running for this sheetId, the new one waits for it to finish first. Different
 * sheets process in parallel.
 */
function enqueueMidiRegeneration(
  userId: string,
  sheetId: string,
  musicxmlKey: string,
  voiceAssignments: Record<string, string>
): Promise<void> {
  const previous = midiGenerationLocks.get(sheetId) ?? Promise.resolve();
  const next = previous
    .catch(() => {}) // don't let a previous failure block the chain
    .then(() => regenerateMidiAsync(userId, sheetId, musicxmlKey, voiceAssignments));

  midiGenerationLocks.set(sheetId, next);

  // Clean up the map entry when this promise settles (if it's still the latest).
  // .catch() suppresses the rejection propagated through .finally() so it doesn't
  // surface as an additional unhandled rejection when the task throws.
  next.finally(() => {
    if (midiGenerationLocks.get(sheetId) === next) {
      midiGenerationLocks.delete(sheetId);
    }
  }).catch(() => {});

  return next;
}

// Helper function to regenerate MIDI files
async function regenerateMidiAsync(
  userId: string,
  sheetId: string,
  musicxmlKey: string,
  voiceAssignments: Record<string, string>
) {
  try {
    // Get the current sheet to check if voice assignments are still current
    const currentSheet = await getSheetMusic(sheetId);
    if (!currentSheet) {
      throw new Error("Sheet not found");
    }

    // Cancel if voice assignments changed since this regeneration was triggered
    if (JSON.stringify(currentSheet.voiceAssignments) !== JSON.stringify(voiceAssignments)) {
      logger.info("MIDI regeneration cancelled: voice assignments changed", { sheetId });
      return;
    }

    // Read MusicXML content — supports both local (filePath) and cloud (URL) storage adapters
    const storageResult = await storageGet(musicxmlKey, 300);
    let musicxmlContent: string;
    if ('filePath' in storageResult && storageResult.filePath) {
      musicxmlContent = await fs.readFile(storageResult.filePath, 'utf-8');
    } else {
      const fileRes = await fetch(storageResult.url);
      if (!fileRes.ok) throw new Error(`Failed to fetch MusicXML from storage: ${fileRes.statusText}`);
      musicxmlContent = await fileRes.text();
    }

    // Call Python service to generate MIDI
    const formData = new FormData();
    formData.append('musicxml', musicxmlContent);
    formData.append('voice_assignments', JSON.stringify(voiceAssignments));

    const midiController = new AbortController();
    const midiTimeoutId = setTimeout(() => midiController.abort(), 60000); // 60 s for MIDI generation
    const midiStart = Date.now();
    const response = await fetch(`${PYTHON_SERVICE_URL}/api/generate-midi`, {
      method: 'POST',
      body: formData as any,
      headers: {
        ...formData.getHeaders(),
        ...INTERNAL_TOKEN_HEADER, // B-10: internal auth
      },
      signal: midiController.signal as any,
    });
    clearTimeout(midiTimeoutId);
    logger.info("MIDI generation responded", {
      sheetId,
      durationMs: Date.now() - midiStart,
      status: response.status,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(parsePythonError(errorText));
    }

    const result = await response.json() as {
      success: boolean;
      midi_files: Record<string, string>; // base64 encoded MIDI files
    };

    if (!result.success) {
      throw new Error("MIDI generation failed");
    }

    // Double-check that voice assignments are still current after processing
    const sheetAfterProcessing = await getSheetMusic(sheetId);
    if (!sheetAfterProcessing) {
      throw new Error("Sheet not found after processing");
    }

    if (JSON.stringify(sheetAfterProcessing.voiceAssignments) !== JSON.stringify(voiceAssignments)) {
      logger.info("MIDI regeneration cancelled after processing: voice assignments changed", { sheetId });
      return;
    }

    // Save MIDI files to local storage
    const midiFileKeys: Record<string, string> = {};

    for (const [voiceType, base64Data] of Object.entries(result.midi_files)) {
      const midiBuffer = Buffer.from(base64Data, 'base64');
      const midiKey = `sheet-music/${userId}/${sheetId}/midi/${voiceType}.mid`;

      const { key } = await storagePut(midiKey, midiBuffer, "audio/midi");
      midiFileKeys[voiceType] = key;
    }

    // Update database with MIDI file keys
    await updateSheetMusic(sheetId, {
      midiFileKeys,
    });

  } catch (error) {
    logger.error("MIDI generation failed", { sheetId, err: String(error) });
    throw error;
  }
}
