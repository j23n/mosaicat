/**
 * The wall between `pull` and `build`.
 *
 * `pull` writes here and `build` reads here, so a build is a pure function of
 * what is on disk. Raw records are stored, not interpreted ones: raw JSON stays
 * valid across code changes, whereas a cached parse would go stale the moment a
 * field is renamed. Re-parsing costs microseconds.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobRecord } from "./blob.js";
import type { RawRecord } from "./repo.js";

/** Bumped when the on-disk shape changes; a mismatch is treated as a miss. */
export const CACHE_VERSION = 2;

export interface SourceCache {
  version: number;
  source: string;
  did: string;
  pdsUrl: string;
  /** ISO timestamp of the pull that produced this. */
  fetchedAt: string;
  /** Records by collection NSID. */
  collections: Record<string, RawRecord[]>;
  /** Blobs downloaded alongside them, so `build` knows each CID's type. */
  blobs: BlobRecord[];
}

function cachePath(cacheDir: string, sourceName: string): string {
  return join(cacheDir, `${sourceName}.json`);
}

export async function writeSourceCache(cacheDir: string, cache: SourceCache): Promise<string> {
  const path = cachePath(cacheDir, cache.source);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return path;
}

/** Read a cache entry, or null when absent, unreadable, or the wrong version. */
export async function readSourceCache(
  cacheDir: string,
  sourceName: string,
): Promise<SourceCache | null> {
  let text: string;
  try {
    text = await readFile(cachePath(cacheDir, sourceName), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as SourceCache;
    if (parsed?.version !== CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function countRecords(cache: SourceCache): number {
  return Object.values(cache.collections).reduce((total, list) => total + list.length, 0);
}
