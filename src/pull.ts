/**
 * `atmo pull` — the only part of the tool that touches the network.
 */

import type { Config } from "./config.js";
import { writeSourceCache, CACHE_VERSION, type SourceCache } from "./cache.js";
import { cachedBlobs, documentCids, fetchBlob, type BlobRecord } from "./blob.js";
import { DOCUMENT_NSID } from "./config.js";
import { collectDocuments } from "./document.js";
import { resolveSource, type ResolveOptions } from "./identity.js";
import { listRecords } from "./repo.js";

export interface PullOptions extends ResolveOptions {
  /** Injected so tests get deterministic timestamps. */
  now?: () => Date;
  log?: (line: string) => void;
}

export interface PullResult {
  source: string;
  did: string;
  records: number;
  blobs: number;
  path: string;
}

/**
 * Fetch every configured source into the cache.
 *
 * A source that fails aborts the pull. That is deliberate: the alternative —
 * writing a partial cache — hands `build` something that looks complete and is
 * not, and the resulting site would silently drop a section.
 */
export async function pull(config: Config, options: PullOptions = {}): Promise<PullResult[]> {
  const { now = () => new Date(), log = () => {} } = options;
  const results: PullResult[] = [];

  for (const source of config.source) {
    const identity = await resolveSource(source, options);
    log(`${source.name}: ${identity.did} @ ${identity.pdsUrl}`);

    const collections: Record<string, ReturnType<typeof Array.prototype.slice>> = {};
    let total = 0;

    for (const collection of source.collections) {
      const records = await listRecords(identity, collection, {
        maxRecords: source.max_records,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
      });
      collections[collection] = records;
      total += records.length;
      log(`  ${collection}: ${records.length} record(s)`);
    }

    // Blobs are content-addressed, so an already-cached CID is never refetched.
    const documents = collectDocuments(
      source.name,
      identity.did,
      source.publication,
      collections[DOCUMENT_NSID] ?? [],
    );
    const existing = await cachedBlobs(config.cache_dir);
    const blobs: BlobRecord[] = [];
    const wanted = new Set(documents.flatMap(documentCids));

    for (const cid of wanted) {
      const blob = await fetchBlob(config.cache_dir, identity, cid, existing, {
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
      });
      // A blob that will not download is a broken image, not a failed build.
      if (blob !== null) blobs.push(blob);
    }
    if (wanted.size > 0) log(`  blobs: ${blobs.length}/${wanted.size}`);

    const cache: SourceCache = {
      version: CACHE_VERSION,
      source: source.name,
      did: identity.did,
      pdsUrl: identity.pdsUrl,
      fetchedAt: now().toISOString(),
      collections: collections as SourceCache["collections"],
      blobs,
    };

    const path = await writeSourceCache(config.cache_dir, cache);
    results.push({
      source: source.name,
      did: identity.did,
      records: total,
      blobs: blobs.length,
      path,
    });
  }

  return results;
}
