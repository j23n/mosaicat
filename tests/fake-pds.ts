/**
 * A fake ATProto network: an in-memory resolver, PLC directory, and PDS.
 *
 * Tests drive the real code paths against this, so nothing in the suite ever
 * opens a socket and every response shape is one a test chose.
 */

import type { Fetcher, Lookup } from "../src/http.js";

export interface FakeRepo {
  did: string;
  handle?: string;
  pdsUrl: string;
  /** Records by collection, newest first as a PDS would return them. */
  collections: Record<string, { rkey: string; value: Record<string, unknown> }[]>;
}

export interface FakeNetwork {
  fetcher: Fetcher;
  dnsLookup: Lookup;
  /** Every URL requested, in order. */
  calls: string[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeNetwork(repos: FakeRepo[]): FakeNetwork {
  const calls: string[] = [];
  const byHandle = new Map(repos.filter((r) => r.handle).map((r) => [r.handle!, r]));
  const byDid = new Map(repos.map((r) => [r.did, r]));

  const fetcher: Fetcher = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push(url.toString());
    // plc.directory paths carry a percent-encoded DID.
    const path = decodeURIComponent(url.pathname);

    if (path.endsWith("/xrpc/com.atproto.identity.resolveHandle")) {
      const repo = byHandle.get(url.searchParams.get("handle") ?? "");
      return repo ? json({ did: repo.did }) : json({ error: "NotFound" }, 400);
    }

    if (path.startsWith("/did:")) {
      const repo = byDid.get(path.slice(1));
      if (!repo) return json({ error: "NotFound" }, 404);
      return json({
        id: repo.did,
        service: [
          {
            id: "#atproto_pds",
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: repo.pdsUrl,
          },
        ],
      });
    }

    if (path.endsWith("/xrpc/com.atproto.repo.listRecords")) {
      const repo = byDid.get(url.searchParams.get("repo") ?? "");
      if (!repo) return json({ error: "RepoNotFound" }, 400);
      const collection = url.searchParams.get("collection") ?? "";
      const all = repo.collections[collection] ?? [];
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const slice = all.slice(start, start + limit);
      const next = start + slice.length;
      return json({
        records: slice.map((r) => ({
          uri: `at://${repo.did}/${collection}/${r.rkey}`,
          cid: `bafy${r.rkey}`,
          value: r.value,
        })),
        ...(next < all.length ? { cursor: String(next) } : {}),
      });
    }

    return json({ error: "NotImplemented", path }, 404);
  };

  // Everything in the fake network is "public" unless a test says otherwise.
  const dnsLookup: Lookup = async () => ["93.184.216.34"];

  return { fetcher, dnsLookup, calls };
}

/** Build N documents with predictable TID-ish rkeys and timestamps. */
export function documents(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, i) => {
    const n = count - i; // newest first
    return {
      rkey: `3k${String(n).padStart(11, "a")}`,
      value: {
        $type: "site.standard.document",
        title: `Post ${n}`,
        path: `/post-${n}`,
        publishedAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`,
        textContent: `Body of post ${n}.`,
        ...overrides,
      },
    };
  });
}
