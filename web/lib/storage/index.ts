import { config } from "../config";
import { LocalStorageAdapter } from "./local";
import { S3StorageAdapter } from "./s3";
import type { StorageAdapter } from "./types";

let adapter: StorageAdapter | null = null;

export function storage(): StorageAdapter {
  if (!adapter) {
    adapter = config.storageBackend === "s3" ? new S3StorageAdapter() : new LocalStorageAdapter();
  }
  return adapter;
}

export type { StorageAdapter, UploadedPart } from "./types";
