/**
 * `atmo pull` — the only part of the tool that touches the network.
 */

import type { Config } from "./config.js";
import { writeSourceCache, CACHE_VERSION, type SourceCache } from "./cache.js";
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

    const cache: SourceCache = {
      version: CACHE_VERSION,
      source: source.name,
      did: identity.did,
      pdsUrl: identity.pdsUrl,
      fetchedAt: now().toISOString(),
      collections: collections as SourceCache["collections"],
    };

    const path = await writeSourceCache(config.cache_dir, cache);
    results.push({ source: source.name, did: identity.did, records: total, path });
  }

  return results;
}
