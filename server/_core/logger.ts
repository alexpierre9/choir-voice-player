/**
 * Lightweight structured logger.
 *
 * In production (NODE_ENV=production): emits newline-delimited JSON to stdout,
 * compatible with log aggregators (Datadog, Logtail, CloudWatch, etc.).
 *
 * In development: emits human-readable, prefixed console output.
 *
 * Usage:
 *   import { logger } from "./_core/logger";
 *   logger.info("Server started", { port: 3000 });
 *   logger.error("DB failed", { err: error.message });
 *
 * Request-scoped logging (includes req_id):
 *   const log = logger.child({ req_id: "abc123" });
 *   log.info("Processing upload");
 */

const IS_PROD = process.env.NODE_ENV === "production";

type LogLevel = "debug" | "info" | "warn" | "error";

type Meta = Record<string, unknown>;

function emit(level: LogLevel, msg: string, meta?: Meta): void {
  if (IS_PROD) {
    // Structured JSON — one line per entry for log aggregators
    const entry = {
      time: new Date().toISOString(),
      level,
      msg,
      ...meta,
    };
    // Use the native console methods so they map to the correct stderr/stdout
    if (level === "error" || level === "warn") {
      console.error(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
  } else {
    // Human-readable for local development
    const prefix = `[${level.toUpperCase()}]`;
    const metaStr = meta && Object.keys(meta).length > 0 ? " " + JSON.stringify(meta) : "";
    const line = `${prefix} ${msg}${metaStr}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

class Logger {
  private base: Meta;

  constructor(base: Meta = {}) {
    this.base = base;
  }

  /** Create a child logger that merges additional fields into every log entry. */
  child(fields: Meta): Logger {
    return new Logger({ ...this.base, ...fields });
  }

  debug(msg: string, meta?: Meta): void {
    emit("debug", msg, { ...this.base, ...meta });
  }

  info(msg: string, meta?: Meta): void {
    emit("info", msg, { ...this.base, ...meta });
  }

  warn(msg: string, meta?: Meta): void {
    emit("warn", msg, { ...this.base, ...meta });
  }

  error(msg: string, meta?: Meta): void {
    emit("error", msg, { ...this.base, ...meta });
  }
}

export const logger = new Logger();
