import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import rateLimit from "express-rate-limit";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
// import { registerOAuthRoutes } from "./oauth"; // disabled: using email+password auth
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { createFileServerHandler } from "../storage-local";
import { markStaleProcessingSheets } from "../db";
import { validateEnv } from "./env";

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

async function startServer() {
  validateEnv();

  const app = express();
  const server = createServer(app);

  // Trust proxy (required for rate limiting behind reverse proxy)
  app.set('trust proxy', 1);

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
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  // On startup: clean up any sheets that were left in "processing" state
  // (e.g. due to a crash during a previous run).
  markStaleProcessingSheets().then(count => {
    if (count > 0) {
      console.log(`[Startup] Marked ${count} stale processing sheet(s) as error.`);
    }
  }).catch(() => {});

  // Periodic sweep every 5 minutes
  setInterval(() => {
    markStaleProcessingSheets().then(count => {
      if (count > 0) {
        console.log(`[Stale check] Marked ${count} sheet(s) as error (timed out).`);
      }
    }).catch(() => {});
  }, 5 * 60 * 1000).unref(); // .unref() so it doesn't prevent clean process exit
}

startServer().catch(console.error);
