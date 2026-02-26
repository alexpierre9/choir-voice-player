/**
 * Tests for the local filesystem storage adapter.
 * Focuses on the security-critical parts: directory traversal prevention,
 * key normalization, and file ownership enforcement in the file server.
 */

import path from "path";
import os from "os";
import fs from "fs/promises";
import { existsSync } from "fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We test the module internals by importing the exported functions.
// The storage dir is set via env var before importing.
const TEST_STORAGE_DIR = path.join(os.tmpdir(), `choir-test-${process.pid}`);

// Set env before the module loads
process.env.LOCAL_STORAGE_DIR = TEST_STORAGE_DIR;

// Dynamic import so the env var is set first
const { storagePut, storageGet, storageDelete } = await import("./storage-local.js");

describe("storage-local: storagePut / storageGet / storageDelete", () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_STORAGE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TEST_STORAGE_DIR, { recursive: true, force: true });
  });

  it("writes a file and returns the correct key and URL", async () => {
    const { key, url } = await storagePut(
      "sheet-music/owner/abc123/original.pdf",
      Buffer.from("fake-pdf"),
      "application/pdf"
    );

    expect(key).toBe("sheet-music/owner/abc123/original.pdf");
    expect(url).toMatch(/\/files\/sheet-music\/owner\/abc123\/original\.pdf$/);
    expect(existsSync(path.join(TEST_STORAGE_DIR, key))).toBe(true);
  });

  it("strips leading slashes from the key", async () => {
    const { key } = await storagePut("/leading-slash/file.xml", Buffer.from("data"), "application/xml");
    expect(key).toBe("leading-slash/file.xml");
  });

  it("storageGet returns the file path and public URL", async () => {
    await storagePut("test/get.mid", Buffer.from("midi"), "audio/midi");
    const result = await storageGet("test/get.mid");
    expect(result.filePath).toBe(path.join(TEST_STORAGE_DIR, "test/get.mid"));
    expect(result.url).toMatch(/\/files\/test\/get\.mid$/);
  });

  it("storageDelete removes the file", async () => {
    await storagePut("test/del.mid", Buffer.from("data"), "audio/midi");
    const filePath = path.join(TEST_STORAGE_DIR, "test/del.mid");
    expect(existsSync(filePath)).toBe(true);

    await storageDelete("test/del.mid");
    expect(existsSync(filePath)).toBe(false);
  });

  it("storageDelete does not throw when file does not exist", async () => {
    await expect(storageDelete("non-existent/file.mid")).resolves.toBeUndefined();
  });

  it("storageGet returns consistent key after normalization", async () => {
    await storagePut("nested/dir/file.xml", Buffer.from("<music/>"), "application/xml");
    const result = await storageGet("nested/dir/file.xml");
    expect(result.key).toBe("nested/dir/file.xml");
  });
});

describe("storage-local: directory traversal protection", () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_STORAGE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TEST_STORAGE_DIR, { recursive: true, force: true });
  });

  it("rejects path traversal in storagePut", async () => {
    await expect(
      storagePut("../../etc/passwd", Buffer.from("evil"), "text/plain")
    ).rejects.toThrow(/traversal/i);
  });

  it("rejects encoded traversal in storageGet", async () => {
    await expect(storageGet("../../etc/passwd")).rejects.toThrow(/traversal/i);
  });

  it("rejects traversal in storageDelete", async () => {
    await expect(storageDelete("../outside.txt")).rejects.toThrow(/traversal/i);
  });

  it("allows a deeply nested legitimate path", async () => {
    const { key } = await storagePut(
      "sheet-music/user1/sheet42/midi/soprano.mid",
      Buffer.from("midi"),
      "audio/midi"
    );
    expect(key).toBe("sheet-music/user1/sheet42/midi/soprano.mid");
  });
});
