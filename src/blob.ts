/**
 * Blobs become local files.
 *
 * A blob's CID is a hash of its bytes, so the same image uploaded to two repos
 * has the same CID, and a given CID's content can never change. That single
 * property makes the blob cache the simplest correct cache in the tool: if the
 * file exists, it is right. There is no invalidation, no TTL, no staleness —
 * the key *is* the content.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Document } from "./document.js";
import { assertPublicUrl, type Fetcher, type Lookup } from "./http.js";
import type { Identity } from "./identity.js";

/** Where blobs live inside the cache directory. */
export const BLOB_DIR = "blobs";

/** Site-absolute prefix the emitted files are served from. */
export const BLOB_URL_PREFIX = "/assets/blobs";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

export function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType.split(";")[0]!.trim().toLowerCase()] ?? "bin";
}

export function blobFilename(cid: string, mimeType: string): string {
  return `${cid}.${extensionFor(mimeType)}`;
}

export function blobUrl(cid: string, mimeType: string): string {
  return `${BLOB_URL_PREFIX}/${blobFilename(cid, mimeType)}`;
}

/**
 * Every CID a document references.
 *
 * Three places, because three different tools write documents three ways:
 * the `coverImage` field, an `images` array of blob refs, and `getBlob` URLs
 * embedded directly in the body text.
 */
export function documentCids(doc: Document): string[] {
  const cids = new Set<string>();
  if (doc.cover !== null) cids.add(doc.cover.cid);
  for (const cid of contentCids(doc.content)) cids.add(cid);
  return [...cids];
}

/** CIDs of `getBlob` URLs appearing anywhere in a body. */
export function contentCids(content: string): string[] {
  const cids = new Set<string>();
  const pattern = /getBlob\?[^\s")']*\bcid=([A-Za-z0-9]+)/g;
  for (const match of content.matchAll(pattern)) {
    if (match[1] !== undefined) cids.add(match[1]);
  }
  return [...cids];
}

/** What a downloaded blob is recorded as. */
export interface BlobRecord {
  cid: string;
  mimeType: string;
  bytes: number;
}

/** Filenames already present in the blob cache. */
export async function cachedBlobs(cacheDir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(join(cacheDir, BLOB_DIR)));
  } catch {
    return new Set();
  }
}

export interface FetchBlobOptions {
  fetcher?: Fetcher;
  dnsLookup?: Lookup;
  timeoutMs?: number;
}

/**
 * Download one blob into the cache, unless a file for that CID is already
 * there. Returns null when the blob cannot be fetched — a missing image is a
 * broken `<img>`, never a failed build.
 */
export async function fetchBlob(
  cacheDir: string,
  identity: Identity,
  cid: string,
  existing: Set<string>,
  options: FetchBlobOptions = {},
): Promise<BlobRecord | null> {
  for (const name of existing) {
    if (name.startsWith(`${cid}.`)) {
      const mimeType = mimeFromFilename(name);
      return { cid, mimeType, bytes: 0 };
    }
  }

  const { fetcher = globalThis.fetch, timeoutMs = 30_000 } = options;
  const url = new URL(`${identity.pdsUrl}/xrpc/com.atproto.sync.getBlob`);
  url.searchParams.set("did", identity.did);
  url.searchParams.set("cid", cid);

  try {
    if (!identity.trusted) await assertPublicUrl(url.toString(), options.dnsLookup);
    const response = await fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;

    const mimeType = (response.headers.get("content-type") ?? "application/octet-stream")
      .split(";")[0]!
      .trim();
    const bytes = Buffer.from(await response.arrayBuffer());

    const dir = join(cacheDir, BLOB_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, blobFilename(cid, mimeType)), bytes);

    existing.add(blobFilename(cid, mimeType));
    return { cid, mimeType, bytes: bytes.length };
  } catch {
    return null;
  }
}

function mimeFromFilename(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  for (const [mime, candidate] of Object.entries(EXTENSIONS)) {
    if (candidate === ext) return mime;
  }
  return "application/octet-stream";
}

/**
 * Rewrite `getBlob` URLs in HTML to local asset paths.
 *
 * Rewriting happens on the *rendered* HTML rather than the markdown source so
 * that it runs after sanitizing — a rewrite that reintroduced an attribute the
 * sanitizer had removed would be a hole.
 */
export function rewriteBlobUrls(html: string, mimeByCid: Map<string, string>): string {
  return html.replace(
    /(src|href)="([^"]*getBlob\?[^"]*\bcid=([A-Za-z0-9]+)[^"]*)"/g,
    (whole, attr: string, _url: string, cid: string) => {
      const mimeType = mimeByCid.get(cid);
      if (mimeType === undefined) return whole;
      return `${attr}="${blobUrl(cid, mimeType)}"`;
    },
  );
}
