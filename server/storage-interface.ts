/**
 * Common interface for storage adapters.
 *
 * Two implementations exist:
 *  - storage-local.ts  — local filesystem (active, used by default)
 *  - storage.ts        — Forge cloud API (inactive, requires API credentials)
 *
 * To switch adapters, update the re-export in storage-active.ts.
 */

export interface StorageResult {
  key: string;
  url: string;
  /** Present only for local-filesystem adapter (avoids a network round-trip). */
  filePath?: string;
}

export interface StorageAdapter {
  /**
   * Write data to the given key. Creates intermediate directories as needed.
   * @returns the canonical key and public URL.
   */
  storagePut(
    relKey: string,
    data: Buffer | Uint8Array | string,
    contentType?: string
  ): Promise<{ key: string; url: string }>;

  /**
   * Resolve a key to its download URL (and optionally a local file path).
   * @param expiresIn Seconds until the URL expires (relevant for signed URLs).
   */
  storageGet(relKey: string, expiresIn?: number): Promise<StorageResult>;

  /**
   * Delete a stored file. Should be a no-op if the file does not exist.
   */
  storageDelete(relKey: string): Promise<void>;
}
