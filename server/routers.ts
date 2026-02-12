import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import { 
  createSheetMusic, 
  updateSheetMusic, 
  getSheetMusic, 
  getUserSheetMusic,
  deleteSheetMusic 
} from "./db";
import { storagePut, storageGet, storageDelete } from "./storage";
import FormData from "form-data";
import fetch from "node-fetch";

// Python service URL
const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || "http://localhost:8001";

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  sheetMusic: router({
    // Upload and process a file (PDF or MusicXML)
    upload: protectedProcedure
      .input(z.object({
        filename: z.string(),
        fileType: z.enum(["pdf", "musicxml"]),
        fileData: z.string(), // base64 encoded
        title: z.string().optional(),
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

        // Upload original file to S3
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
        voiceAssignments: z.record(z.string(), z.string()), // { "0": "soprano", "1": "alto", ... }
      }))
      .mutation(async ({ ctx, input }) => {
        const sheet = await getSheetMusic(input.id);
        
        if (!sheet) {
          throw new Error("Sheet music not found");
        }
        
        if (sheet.userId !== ctx.user.id) {
          throw new Error("Unauthorized");
        }
        
        // Update voice assignments
        await updateSheetMusic(input.id, {
          voiceAssignments: input.voiceAssignments as any,
        });
        
        // Regenerate MIDI files
        if (sheet.musicxmlKey) {
          regenerateMidiAsync(sheet.userId, input.id, sheet.musicxmlKey, input.voiceAssignments).catch(err => {
            console.error(`Failed to regenerate MIDI for ${input.id}:`, err);
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
        const midiKey = midiKeys[input.voice];
        
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

// Helper function to process sheet music asynchronously
async function processSheetMusicAsync(
  sheetId: string,
  fileBuffer: Buffer,
  fileType: "pdf" | "musicxml"
) {
  try {
    // Call Python service
    const formData = new FormData();
    formData.append('file', fileBuffer, {
      filename: `file.${fileType === "pdf" ? "pdf" : "musicxml"}`,
      contentType: fileType === "pdf" ? "application/pdf" : "application/xml",
    });
    
    const endpoint = fileType === "pdf" ? "/api/process-pdf" : "/api/process-musicxml";
    const response = await fetch(`${PYTHON_SERVICE_URL}${endpoint}`, {
      method: 'POST',
      body: formData as any,
    });
    
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
    
    // Upload MusicXML to S3
    const sheet = await getSheetMusic(sheetId);
    if (!sheet) throw new Error("Sheet not found");
    
    const musicxmlKey = `sheet-music/${sheet.userId}/${sheetId}/score.musicxml`;
    await storagePut(musicxmlKey, result.musicxml, "application/xml");
    
    // Create initial voice assignments from analysis
    const voiceAssignments: Record<string, string> = {};
    for (const part of result.analysis.parts) {
      voiceAssignments[part.index.toString()] = part.detected_voice;
    }
    
    // Update database with analysis results
    await updateSheetMusic(sheetId, {
      status: "ready",
      musicxmlKey,
      analysisResult: result.analysis,
      voiceAssignments,
    });
    
    // Generate MIDI files
    await regenerateMidiAsync(sheet.userId, sheetId, musicxmlKey, voiceAssignments);
    
  } catch (error) {
    console.error("Processing error:", error);
    await updateSheetMusic(sheetId, {
      status: "error",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
  }
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

    // Get MusicXML content from S3
    const { url: musicxmlUrl } = await storageGet(musicxmlKey, 300);
    const musicxmlResponse = await fetch(musicxmlUrl);
    const musicxmlContent = await musicxmlResponse.text();

    // Call Python service to generate MIDI
    const formData = new FormData();
    formData.append('musicxml', musicxmlContent);
    formData.append('voice_assignments', JSON.stringify(voiceAssignments));

    const response = await fetch(`${PYTHON_SERVICE_URL}/api/generate-midi`, {
      method: 'POST',
      body: formData as any,
    });

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

    // Upload MIDI files to S3
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

