// Local filesystem storage adapter for VPS deployment
import path from 'path';
import fs from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import { mkdir } from 'fs/promises';

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR || '/var/lib/choir-files';
const PUBLIC_URL_BASE = process.env.PUBLIC_URL_BASE || 'https://babtech.io/files';

// Ensure storage directory exists
async function ensureStorageDir() {
  if (!existsSync(STORAGE_DIR)) {
    await mkdir(STORAGE_DIR, { recursive: true });
  }
}

function normalizeKey(relKey: string): string {
  // Prevent directory traversal
  return relKey.replace(/\.\./g, '').replace(/^\/+/, '');
}

function getFilePath(relKey: string): string {
  const key = normalizeKey(relKey);
  return path.join(STORAGE_DIR, key);
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  await ensureStorageDir();
  const key = normalizeKey(relKey);
  const filePath = getFilePath(key);
  
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

// Express middleware to serve files
export function createFileServerHandler() {
  return async (req: any, res: any, next: any) => {
    const filePath = path.join(STORAGE_DIR, req.path.replace(/^\/files/, ''));
    
    if (!existsSync(filePath)) {
      return next();
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
