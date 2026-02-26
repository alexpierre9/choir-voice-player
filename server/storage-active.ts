/**
 * Active storage adapter.
 *
 * This module is the single import point used throughout the server.
 * To switch from local filesystem to cloud storage, change the import below
 * to "./storage" and ensure the Forge API credentials are set.
 */

export { storagePut, storageGet, storageDelete } from "./storage-local.js";
