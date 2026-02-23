// Local filesystem storage adapter for VPS deployment
import path from 'path';
import fs from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import { mkdir } from 'fs/promises';
import { COOKIE_NAME } from '@shared/const';
import { sdk } from './_core/sdk';

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR || '/var/lib/choir-files';
const RESOLVED_STORAGE_DIR = path.resolve(STORAGE_DIR);
const PUBLIC_URL_BASE = process.env.PUBLIC_URL_BASE || '/files';

// Ensure storage directory exists
async function ensureStorageDir() {
  if (!existsSync(RESOLVED_STORAGE_DIR)) {
    await mkdir(RESOLVED_STORAGE_DIR, { recursive: true });
  }
}

/**
 * Resolve a relative key to an absolute file path inside STORAGE_DIR.
 * Throws if the resolved path escapes the storage directory (directory traversal).
 */
function getFilePath(relKey: string): string {
  const resolved = path.resolve(RESOLVED_STORAGE_DIR, relKey);
  if (!resolved.startsWith(RESOLVED_STORAGE_DIR + path.sep) && resolved !== RESOLVED_STORAGE_DIR) {
    throw new Error('Directory traversal detected');
  }
  return resolved;
}

/** Strip leading slashes from a storage key (keeps internal segments intact). */
function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, '');
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  await ensureStorageDir();
  const key = normalizeKey(relKey);
  const filePath = getFilePath(key); // validates traversal
  
  // Ensure subdirectory exists
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  
  // Write file
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data);
  await fs.writeFile(filePath, buffer);
  
  // Return public URL
  const url = `${PUBLIC_URL_BASE}/${key}`;
  return { key, url };
}

export async function storageGet(
  relKey: string,
  _expiresIn = 300
): Promise<{ key: string; url: string; filePath: string }> {
  const key = normalizeKey(relKey);
  const filePath = getFilePath(key);
  const url = `${PUBLIC_URL_BASE}/${key}`;
  return { key, url, filePath };
}

export async function storageDelete(relKey: string): Promise<void> {
  const filePath = getFilePath(relKey);
  try {
    await fs.unlink(filePath);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

// Express middleware to serve files (authenticated, ownership-checked)
export function createFileServerHandler() {
  return async (req: any, res: any, next: any) => {
    // --- Auth: verify JWT session cookie (no DB round-trip) ---
    const { parse: parseCookieHeader } = await import('cookie');
    const cookies = req.headers.cookie ? parseCookieHeader(req.headers.cookie) : {};
    const session = await sdk.verifySession(cookies[COOKIE_NAME]);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // --- Ownership: files live under sheet-music/<userId>/... ---
    const requestedPath = req.path.replace(/^\/+/, '');
    const pathSegments = requestedPath.split('/');
    // Expected: sheet-music/<userId>/<sheetId>/...
    if (pathSegments[0] === 'sheet-music' && pathSegments[1] && pathSegments[1] !== session.openId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Resolve the requested path and verify it stays inside STORAGE_DIR
    let filePath: string;
    try {
      filePath = getFilePath(requestedPath);
    } catch {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Simple static file serving
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.mid': 'audio/midi',
      '.midi': 'audio/midi',
      '.xml': 'application/xml',
      '.musicxml': 'application/xml',
      '.pdf': 'application/pdf',
    };

    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    createReadStream(filePath).pipe(res);
  };
}
