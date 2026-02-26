import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { randomUUID } from "crypto";
import rateLimit from "express-rate-limit";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
// import { registerOAuthRoutes } from "./oauth"; // disabled: using email+password auth
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { createFileServerHandler } from "../storage-local";
import { markStaleProcessingSheets, getAppSettings } from "../db";
import { validateEnv, ENV } from "./env";
import { logger } from "./logger";
import fetch from "node-fetch";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || "http://localhost:8001";

async function syncGeminiConfigToPython(): Promise<void> {
  const settings = await getAppSettings([
    "gemini_api_key",
    "gemini_model_name",
    "gemini_max_output_tokens",
  ]);

  const payload: Record<string, unknown> = {};
  if (settings.gemini_api_key) payload.gemini_api_key = settings.gemini_api_key;
  if (settings.gemini_model_name) payload.gemini_model_name = settings.gemini_model_name;
  if (settings.gemini_max_output_tokens) payload.gemini_max_output_tokens = parseInt(settings.gemini_max_output_tokens, 10);

  if (Object.keys(payload).length === 0) return;

  const tokenHeader: Record<string, string> = ENV.internalServiceToken
    ? { "X-Internal-Token": ENV.internalServiceToken }
    : {};

  const res = await fetch(`${PYTHON_SERVICE_URL}/api/update-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tokenHeader },
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    logger.info("Synced DB-stored Gemini config to Python service");
  } else {
    logger.warn("Failed to sync Gemini config to Python service", { status: res.status });
  }
}

async function startServer() {
  validateEnv();

  const app = express();
  const server = createServer(app);

  // B-15: Guard against connections that stall while sending the request body.
  // 5 minutes is generous enough for a 50 MB file upload on a slow connection.
  server.requestTimeout = 5 * 60 * 1000;

  // Trust proxy (required for rate limiting behind reverse proxy)
  app.set('trust proxy', 1);

  // Attach a unique request ID to every incoming request.
  // Downstream code can access it via req.reqId for correlation logging.
  app.use((req: any, _res, next) => {
    req.reqId = randomUUID();
    next();
  });

  // Request / response access log (method, path, status, duration).
  app.use((req: any, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      const log = logger.child({ req_id: req.reqId });
      const meta = { method: req.method, path: req.path, status: res.statusCode, ms };
      if (res.statusCode >= 500) {
        log.error("Request completed", meta);
      } else if (res.statusCode >= 400) {
        log.warn("Request completed", meta);
      } else {
        log.info("Request completed", meta);
      }
    });
    next();
  });

  // Health check for Docker healthchecks and uptime monitors.
  // Registered before rate limiters so it always responds immediately.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // General API rate limiter - 100 requests per 15 minutes per IP
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
    skip: (req) => {
      // Skip rate limiting in development
      return process.env.NODE_ENV === "development";
    },
  });

  // Stricter rate limiter for uploads - 10 uploads per 15 minutes per IP
  const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Upload limit exceeded. Please try again in 15 minutes." },
    skip: (req) => {
      // Skip rate limiting in development
      return process.env.NODE_ENV === "development";
    },
  });

  // Apply general rate limiting to all requests
  app.use(generalLimiter);

  // Configure body parser with larger size limit for file uploads.
  // NOTE: A 50MB binary file base64-encodes to ~67MB of JSON, so the body limit
  // must be large enough to accommodate that overhead. 100mb covers files up to ~75MB.
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ limit: "100mb", extended: true }));

  // Apply stricter rate limiting to upload endpoint
  app.use("/api/trpc/sheetMusic.upload", uploadLimiter);

  // OAuth disabled: using email+password auth instead
  // registerOAuthRoutes(app);

  // Static file serving for uploaded files (MIDI, PDFs, etc.)
  app.use("/files", createFileServerHandler());

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    logger.warn(`Port ${preferredPort} is busy, using port ${port} instead`, { preferredPort, port });
  }

  server.listen(port, () => {
    logger.info(`Server running on http://localhost:${port}/`, { port });
  });

  // On startup: clean up any sheets that were left in "processing" state
  // (e.g. due to a crash during a previous run).
  markStaleProcessingSheets().then(count => {
    if (count > 0) {
      logger.warn(`Marked stale processing sheets as error`, { count });
    }
  }).catch(() => {});

  // On startup: push any DB-stored Gemini settings to the Python service
  // so it picks up configuration changes that were saved while it was down.
  syncGeminiConfigToPython().catch(() => {});

  // Periodic sweep every 5 minutes
  setInterval(() => {
    markStaleProcessingSheets().then(count => {
      if (count > 0) {
        logger.warn(`Periodic stale check: marked sheets as error`, { count });
      }
    }).catch(() => {});
  }, 5 * 60 * 1000).unref(); // .unref() so it doesn't prevent clean process exit
}

startServer().catch(console.error);
