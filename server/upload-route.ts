/**
 * Multipart file upload route — POST /api/upload
 *
 * Accepts a multipart/form-data request with a `file` field (PDF or MusicXML)
 * and an optional `title` field.  Authenticates via the JWT session cookie,
 * saves the file to storage, creates the DB record, and triggers processing.
 *
 * This replaces the base64-over-tRPC approach while keeping backward compat
 * (the old tRPC upload procedure is still registered but marked deprecated).
 */

import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { COOKIE_NAME } from "@shared/const";
import { sdk } from "./_core/sdk";
import { logger } from "./_core/logger";
import { storagePut } from "./storage-active";
import {
  createSheetMusic,
  updateSheetMusic,
} from "./db";
import { ENV } from "./_core/env";
import { emitProcessingEvent } from "./sse";
import FormData from "form-data";
import fetch from "node-fetch";
import { parse as parseCookieHeader } from "cookie";

// ---------------------------------------------------------------------------
// Multer configuration — store in memory (no temp files needed)
// ---------------------------------------------------------------------------
const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter(_req, file, cb) {
    // Accept only the extensions the app understands
    const allowed = [".pdf", ".xml", ".musicxml", ".mxl"];
    const lower = file.originalname.toLowerCase();
    if (allowed.some((ext) => lower.endsWith(ext))) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type. Please upload a PDF or MusicXML file."));
    }
  },
});

// ---------------------------------------------------------------------------
// Helpers (mirrors the logic in routers.ts processSheetMusicAsync)
// ---------------------------------------------------------------------------

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || "http://localhost:8001";

const INTERNAL_TOKEN_HEADER: Record<string, string> = ENV.internalServiceToken
  ? { "X-Internal-Token": ENV.internalServiceToken }
  : {};

function getFileType(filename: string): "pdf" | "musicxml" {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  return "musicxml";
}

/**
 * Trigger async processing pipeline — identical logic to the tRPC upload mutation.
 * Imported inline to avoid circular dependencies.
 */
async function processSheetMusicAsync(
  sheetId: string,
  userId: string,
  fileBuffer: Buffer,
  fileType: "pdf" | "musicxml"
): Promise<void> {
  // Emit initial queued event
  emitProcessingEvent(sheetId, "status", { status: "processing", progress: 0 });

  // Build multipart request to Python service
  const formData = new FormData();
  const filename = fileType === "pdf" ? "original.pdf" : "original.musicxml";
  formData.append("file", fileBuffer, {
    filename,
    contentType: fileType === "pdf" ? "application/pdf" : "application/xml",
  });
  formData.append("sheet_id", sheetId);
  formData.append("user_id", userId);
  formData.append("file_type", fileType);

  const res = await fetch(`${PYTHON_SERVICE_URL}/api/process`, {
    method: "POST",
    headers: {
      ...INTERNAL_TOKEN_HEADER,
      ...formData.getHeaders(),
    },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Python service returned ${res.status}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Express router
// ---------------------------------------------------------------------------
export const uploadRouter = Router();

uploadRouter.post(
  "/api/upload",
  upload.single("file"),
  async (req: any, res: any) => {
    // --- Auth: verify JWT session cookie ---
    const cookies = req.headers.cookie ? parseCookieHeader(req.headers.cookie) : {};
    const session = await sdk.verifySession(cookies[COOKIE_NAME]);
    if (!session) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }

    const userId = session.openId;
    const sheetId = nanoid();
    const fileBuffer = req.file.buffer;
    const filename = req.file.originalname;
    const fileType = getFileType(filename);
    const rawTitle = (req.body?.title as string | undefined)?.trim() ?? "";
    const title = rawTitle.slice(0, 255) || filename.replace(/\.[^/.]+$/, "");

    if (fileBuffer.length > MAX_SIZE_BYTES) {
      res.status(400).json({ error: `File size exceeds the maximum allowed size of ${MAX_SIZE_BYTES / (1024 * 1024)} MB` });
      return;
    }

    logger.info("Sheet music upload (multipart)", {
      sheetId,
      userId,
      filename,
      fileType,
      sizeBytes: fileBuffer.length,
    });

    // Save original file to storage
    const fileExtension = fileType === "pdf" ? "pdf" : "musicxml";
    const originalFileKey = `sheet-music/${userId}/${sheetId}/original.${fileExtension}`;

    const { key: uploadedKey } = await storagePut(
      originalFileKey,
      fileBuffer,
      fileType === "pdf" ? "application/pdf" : "application/xml"
    );

    // Create DB record
    await createSheetMusic({
      id: sheetId,
      userId,
      title,
      originalFilename: filename,
      fileType,
      originalFileKey: uploadedKey,
      status: "processing",
    });

    // Trigger async processing (fire-and-forget; errors update DB status)
    processSheetMusicAsync(sheetId, userId, fileBuffer, fileType).catch(async (err) => {
      logger.error("Failed to process sheet music (multipart upload)", {
        sheetId,
        err: String(err),
      });
      try {
        await updateSheetMusic(sheetId, {
          status: "error",
          errorMessage: (err as Error).message,
        });
      } catch (updateErr) {
        logger.error("Failed to update error status", { sheetId, err: String(updateErr) });
      }
    });

    res.json({ sheetId, status: "processing" });
  }
);
