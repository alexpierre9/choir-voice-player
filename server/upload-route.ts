/**
 * Multipart upload route — replaces the base64 tRPC upload mutation.
 * POST /api/upload  (multipart/form-data, field: "file", optional "title")
 */
import express from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { createSheetMusic } from "./db";
import { storagePut } from "./storage-local";
import { processSheetMusicAsync } from "./routers";
import { sdk } from "./_core/sdk";

const upload = multer({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  storage: multer.memoryStorage(),
});

export const uploadRouter = express.Router();

const ALLOWED_EXTENSIONS = new Set(["pdf", "xml", "musicxml", "mxl"]);

uploadRouter.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    // Auth — use same mechanism as tRPC context
    let user: Awaited<ReturnType<typeof sdk.authenticateRequest>> | null = null;
    try {
      user = await sdk.authenticateRequest(req as any);
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filename = req.file.originalname;
    const ext = filename.toLowerCase().split(".").pop() ?? "";

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: "Invalid file type. Allowed: pdf, xml, musicxml, mxl" });
    }

    const fileType: "pdf" | "musicxml" = ext === "pdf" ? "pdf" : "musicxml";
    const sheetId = nanoid();
    const fileBuffer = req.file.buffer;
    const originalFileKey = `sheet-music/${user.id}/${sheetId}/original.${ext}`;

    const { key } = await storagePut(
      originalFileKey,
      fileBuffer,
      fileType === "pdf" ? "application/pdf" : "application/xml"
    );

    const title: string =
      (typeof req.body.title === "string" && req.body.title.trim())
        ? req.body.title.trim()
        : filename.replace(/\.[^/.]+$/, "");

    await createSheetMusic({
      id: sheetId,
      userId: user.id,
      title,
      originalFilename: filename,
      fileType,
      originalFileKey: key,
      status: "processing",
    });

    // Kick off async processing (non-blocking)
    processSheetMusicAsync(sheetId, fileBuffer, fileType).catch((err: Error) => {
      console.error(`[upload-route] processSheetMusicAsync failed for ${sheetId}:`, err);
    });

    return res.status(202).json({ id: sheetId, status: "processing" });
  } catch (err: any) {
    console.error("[upload-route] Unexpected error:", err);
    return res.status(500).json({ error: err?.message ?? "Internal server error" });
  }
});
