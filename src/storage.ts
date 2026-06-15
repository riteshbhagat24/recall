import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, extname } from 'node:path';
import { config } from './config.js';

/**
 * Owned local storage for audio (PRD: "audio in owned storage" — never a
 * third-party bucket at MVP). On the VPS this maps to a mounted volume.
 */
const ROOT = resolve(config.STORAGE_ROOT);

export async function ensureStorage(): Promise<void> {
  await mkdir(ROOT, { recursive: true });
}

export interface StoredFile {
  storagePath: string;
  checksum: string;
  sizeBytes: number;
}

/** Persist an uploaded buffer, returning its path + content checksum (dedupe). */
export async function storeUpload(
  buffer: Buffer,
  originalName: string,
): Promise<StoredFile> {
  await ensureStorage();
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const ext = extname(originalName).toLowerCase() || '.bin';
  const storagePath = join(ROOT, `${checksum}${ext}`);
  await writeFile(storagePath, buffer);
  return { storagePath, checksum, sizeBytes: buffer.length };
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
