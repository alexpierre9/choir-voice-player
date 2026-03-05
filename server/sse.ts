import { EventEmitter } from "events";
import { Router, Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { parse as parseCookieHeader } from "cookie";
import { COOKIE_NAME } from "@shared/const";
import { getSheetMusic } from "./db";

export const processingEvents = new EventEmitter();
processingEvents.setMaxListeners(100);

export function emitProcessingEvent(
  sheetId: string,
  event: string,
  data: Record<string, unknown>,
) {
  processingEvents.emit(sheetId, { event, data });
}

const sseRouter = Router();

sseRouter.get("/api/sse/sheet/:id", async (req: Request, res: Response) => {
  const sheetId = req.params.id;
  if (!sheetId || sheetId.length > 64) {
    res.status(400).end();
    return;
  }

  // Auth check via JWT cookie
  const cookies = parseCookieHeader(req.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token) {
    res.status(401).end();
    return;
  }

  let session;
  try {
    session = await sdk.verifySession(token);
  } catch {
    res.status(401).end();
    return;
  }

  if (!session) {
    res.status(401).end();
    return;
  }

  // Ownership check
  const sheet = await getSheetMusic(sheetId);
  if (!sheet || sheet.userId !== session.openId) {
    res.status(404).end();
    return;
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  // Send current status immediately
  res.write(
    `event: status\ndata: ${JSON.stringify({ status: sheet.status, errorMessage: sheet.errorMessage })}\n\n`,
  );

  const listener = ({
    event,
    data,
  }: {
    event: string;
    data: Record<string, unknown>;
  }) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  processingEvents.on(sheetId, listener);

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    res.write(":heartbeat\n\n");
  }, 30_000);

  req.on("close", () => {
    processingEvents.off(sheetId, listener);
    clearInterval(heartbeat);
  });
});

export { sseRouter };
