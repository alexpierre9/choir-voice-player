import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { ENV } from "./_core/env";
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
} from "./db";
import { storagePut, storageGet, storageDelete } from "./storage-local";
import FormData from "form-data";
import fetch from "node-fetch";
import fs from "fs/promises";

// Python service URL
const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || "http://localhost:8001";

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
        await upsertUser({
          id: OWNER_ID,
          name: "Owner",
          loginMethod: "passphrase",
          lastSignedIn: new Date(),
        });

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
    // Upload and process a file (PDF or MusicXML)
    upload: protectedProcedure
      .input(z.object({
        filename: z.string(),
        fileType: z.enum(["pdf", "musicxml"]),
        fileData: z.string(), // base64 encoded
        title: z.string().max(255).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const userId = ctx.user.id;
        const sheetId = nanoid();

        // Decode file data
        const fileBuffer = Buffer.from(input.fileData, 'base64');

        // Validate file size (max 50MB)
        const maxSize = 50 * 1024 * 1024; // 50MB in bytes
        if (fileBuffer.length > maxSize) {
          throw new Error(`File size exceeds maximum allowed size of ${maxSize / (1024 * 1024)}MB`);
        }

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

        // Process file asynchronously
        processSheetMusicAsync(sheetId, fileBuffer, input.fileType).catch(async err => {
          console.error(`Failed to process sheet music ${sheetId}:`, err);
          try {
            await updateSheetMusic(sheetId, {
              status: "error",
              errorMessage: err.message,
            });
          } catch (updateErr) {
            console.error(`Failed to update error status for sheet music ${sheetId}:`, updateErr);
          }
        });

        return {
          id: sheetId,
          status: "processing",
        };
      }),

    // Get sheet music by ID
    get: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ ctx, input }) => {
        const sheet = await getSheetMusic(input.id);

        if (!sheet) {
          throw new Error("Sheet music not found");
        }

        // Check ownership
        if (sheet.userId !== ctx.user.id) {
          throw new Error("Unauthorized");
        }

        return sheet;
      }),

    // List user's sheet music
    list: protectedProcedure
      .query(async ({ ctx }) => {
        return await getUserSheetMusic(ctx.user.id);
      }),

    // Update voice assignments and regenerate MIDI
    updateVoiceAssignments: protectedProcedure
      .input(z.object({
        id: z.string(),
        voiceAssignments: z.record(z.string(), z.enum(["soprano", "alto", "tenor", "bass", "other"])),
      }))
      .mutation(async ({ ctx, input }) => {
        const sheet = await getSheetMusic(input.id);

        if (!sheet) {
          throw new Error("Sheet music not found");
        }

        if (sheet.userId !== ctx.user.id) {
          throw new Error("Unauthorized");
        }

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
              console.error(`Failed to regenerate MIDI for ${input.id}:`, err);
              await updateSheetMusic(input.id, {
                status: "error",
                errorMessage: err instanceof Error ? err.message : "MIDI regeneration failed",
              }).catch(() => {});
            });
        }

        return { success: true };
      }),

    // Get MIDI file URL
    getMidiUrl: protectedProcedure
      .input(z.object({
        id: z.string(),
        voice: z.string(), // "soprano", "alto", "tenor", "bass", or "all"
      }))
      .query(async ({ ctx, input }) => {
        const sheet = await getSheetMusic(input.id);

        if (!sheet) {
          throw new Error("Sheet music not found");
        }

        if (sheet.userId !== ctx.user.id) {
          throw new Error("Unauthorized");
        }

        if (!sheet.midiFileKeys) {
          throw new Error("MIDI files not generated yet");
        }

        const midiKeys = sheet.midiFileKeys as Record<string, string>;
        const midiKey = midiKeys[input.voice] ?? midiKeys["all"];

        if (!midiKey) {
          throw new Error(`MIDI file for voice ${input.voice} not found`);
        }

        // Generate presigned URL (5 minutes)
        const { url } = await storageGet(midiKey, 300);

        return { url };
      }),

    // Delete sheet music
    delete: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const sheet = await getSheetMusic(input.id);

        if (!sheet) {
          throw new Error("Sheet music not found");
        }

        if (sheet.userId !== ctx.user.id) {
          throw new Error("Unauthorized");
        }

        // Delete S3 files asynchronously (don't block on failures)
        const deletePromises: Promise<void>[] = [];

        if (sheet.originalFileKey) {
          deletePromises.push(
            storageDelete(sheet.originalFileKey).catch(err => {
              console.error(`Failed to delete original file ${sheet.originalFileKey}:`, err);
            })
          );
        }

        if (sheet.musicxmlKey) {
          deletePromises.push(
            storageDelete(sheet.musicxmlKey).catch(err => {
              console.error(`Failed to delete musicxml ${sheet.musicxmlKey}:`, err);
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
                  console.error(`Failed to delete midi file ${midiKey}:`, err);
                })
              );
            }
          }
        }

        // Wait for all deletions to complete (with individual error handling)
        await Promise.all(deletePromises);

        await deleteSheetMusic(input.id);

        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;

// Check that the Python processing service is reachable (fast 2s timeout)
async function checkPythonServiceHealth(): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${PYTHON_SERVICE_URL}/health`, {
      signal: controller.signal as any,
    });
    if (!res.ok) {
      throw new Error(`Python service returned HTTP ${res.status}`);
    }
  } catch (err: any) {
    if (err.name === 'AbortError' || err.code === 'ECONNABORTED') {
      throw new Error('Python processing service is not responding (timeout). Please try again later.');
    }
    if (err.code === 'ECONNREFUSED') {
      throw new Error('Python processing service is not running. Please contact the administrator.');
    }
    throw new Error(`Python processing service health check failed: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Helper function to process sheet music asynchronously
async function processSheetMusicAsync(
  sheetId: string,
  fileBuffer: Buffer,
  fileType: "pdf" | "musicxml"
) {
  try {
    // Fail fast if the Python service is unreachable
    await checkPythonServiceHealth();

    // Call Python service
    const formData = new FormData();
    formData.append('file', fileBuffer, {
      filename: `file.${fileType === "pdf" ? "pdf" : "musicxml"}`,
      contentType: fileType === "pdf" ? "application/pdf" : "application/xml",
    });

    const endpoint = fileType === "pdf" ? "/api/process-pdf" : "/api/process-musicxml";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s — multi-page PDFs take longer
    const response = await fetch(`${PYTHON_SERVICE_URL}${endpoint}`, {
      method: 'POST',
      body: formData as any,
      signal: controller.signal as any,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Python service error: ${errorText}`);
    }

    const result = await response.json() as {
      success: boolean;
      musicxml: string;
      analysis: any;
    };

    if (!result.success) {
      throw new Error("Processing failed");
    }

    // Upload MusicXML to local storage
    const sheet = await getSheetMusic(sheetId);
    if (!sheet) throw new Error("Sheet not found");

    const musicxmlKey = `sheet-music/${sheet.userId}/${sheetId}/score.musicxml`;
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
    });

    // Generate MIDI files, then set status to "ready"
    await enqueueMidiRegeneration(sheet.userId, sheetId, musicxmlKey, voiceAssignments);

    await updateSheetMusic(sheetId, { status: "ready" });

  } catch (error) {
    console.error("Processing error:", error);
    await updateSheetMusic(sheetId, {
      status: "error",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
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

  // Clean up the map entry when this promise settles (if it's still the latest)
  next.finally(() => {
    if (midiGenerationLocks.get(sheetId) === next) {
      midiGenerationLocks.delete(sheetId);
    }
  });

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

    // Check if the voice assignments are still the same as when this regeneration was triggered
    if (JSON.stringify(currentSheet.voiceAssignments) !== JSON.stringify(voiceAssignments)) {
      console.log(`MIDI regeneration for ${sheetId} cancelled - voice assignments have changed`);
      return; // Cancel this regeneration since newer assignments exist
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
    const midiTimeoutId = setTimeout(() => midiController.abort(), 60000); // 60s for MIDI generation
    const response = await fetch(`${PYTHON_SERVICE_URL}/api/generate-midi`, {
      method: 'POST',
      body: formData as any,
      signal: midiController.signal as any,
    });
    clearTimeout(midiTimeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MIDI generation error: ${errorText}`);
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
      console.log(`MIDI regeneration for ${sheetId} cancelled after processing - voice assignments have changed`);
      return; // Cancel this update since newer assignments exist
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
    console.error("MIDI generation error:", error);
    throw error;
  }
}

