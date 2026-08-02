/**
 * Reading a collection out of a repo.
 *
 * `com.atproto.repo.listRecords` returns at most 100 records and a cursor.
 * "All the records" is therefore a walk, and the walk is bounded — an enormous
 * or hostile repo must not be able to turn one build into an unbounded crawl.
 */

import type { Identity } from "./identity.js";
import { getJson, type Fetcher, type Lookup } from "./http.js";

/** One record as fetched, before any interpretation of its contents. */
export interface RawRecord {
  uri: string;
  cid: string;
  /** Last segment of the AT-URI. */
  rkey: string;
  /** The record body. Arbitrary JSON — nothing is assumed about it here. */
  value: Record<string, unknown>;
}

const PAGE_SIZE = 100;

interface ListRecordsResponse {
  records?: { uri?: unknown; cid?: unknown; value?: unknown }[];
  cursor?: unknown;
}

export interface ListOptions {
  maxRecords?: number;
  fetcher?: Fetcher;
  dnsLookup?: Lookup;
}

/**
 * Every record in one collection, following the cursor to exhaustion or the
 * cap, whichever comes first.
 *
 * `reverse=true` asks the PDS for descending rkey order. Since rkeys are
 * usually TIDs that is roughly newest-first — which matters only because it
 * decides *which* records survive the cap. Display order is decided later,
 * from a field inside the record, not from this.
 */
export async function listRecords(
  identity: Identity,
  collection: string,
  options: ListOptions = {},
): Promise<RawRecord[]> {
  const { maxRecords = 1000 } = options;
  const records: RawRecord[] = [];
  let cursor: string | undefined;

  while (records.length < maxRecords) {
    const body = await getJson<ListRecordsResponse>(
      `${identity.pdsUrl}/xrpc/com.atproto.repo.listRecords`,
      {
        params: {
          repo: identity.did,
          collection,
          limit: Math.min(PAGE_SIZE, maxRecords - records.length),
          reverse: "true",
          cursor,
        },
        // A configured endpoint may legitimately be on an internal network.
        requirePublic: !identity.trusted,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
      },
    );

    const page = Array.isArray(body.records) ? body.records : [];
    for (const item of page) {
      const uri = typeof item?.uri === "string" ? item.uri : "";
      if (uri === "") continue;
      records.push({
        uri,
        cid: typeof item?.cid === "string" ? item.cid : "",
        rkey: uri.slice(uri.lastIndexOf("/") + 1),
        value:
          typeof item?.value === "object" && item.value !== null
            ? (item.value as Record<string, unknown>)
            : {},
      });
    }

    cursor = typeof body.cursor === "string" ? body.cursor : undefined;
    // No cursor, or a page that advanced nothing: stop rather than loop.
    if (cursor === undefined || page.length === 0) break;
  }

  return records;
}
