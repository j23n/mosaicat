/**
 * A fake ATProto network: an in-memory resolver, PLC directory, and PDS.
 *
 * Tests drive the real code paths against this, so nothing in the suite ever
 * opens a socket and every response shape is one a test chose. The write side
 * (createSession, createRecord, putRecord, deleteRecord, uploadBlob) enforces
 * the bearer token, and blob CIDs are derived from the uploaded bytes so
 * content-addressing stays honest.
 */

import { createHash } from "node:crypto";
import type { Fetcher, Lookup } from "../src/http.js";

export interface FakeRepo {
  did: string;
  handle?: string;
  pdsUrl: string;
  /** Records by collection, newest first as a PDS would return them. */
  collections: Record<string, { rkey: string; value: Record<string, unknown> }[]>;
  /** App password `createSession` accepts. Absent means no login works. */
  password?: string;
}

export interface FakeNetwork {
  fetcher: Fetcher;
  dnsLookup: Lookup;
  /** Every URL requested, in order. */
  calls: string[];
  /** Records written through createRecord/putRecord, by AT-URI. */
  records: Map<string, Record<string, unknown>>;
  /** Uploaded blob bytes, by derived CID. */
  blobs: Map<string, Uint8Array>;
  /** AT-URIs removed through deleteRecord, in order. */
  deleted: string[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const unauthorized = () => json({ error: "AuthenticationRequired" }, 401);

/** A deterministic, bytes-derived CID stand-in. */
export function fakeBlobCid(bytes: Uint8Array): string {
  return `bafkfake${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
}

export function fakeNetwork(repos: FakeRepo[]): FakeNetwork {
  const calls: string[] = [];
  const records = new Map<string, Record<string, unknown>>();
  const blobs = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const byHandle = new Map(repos.filter((r) => r.handle).map((r) => [r.handle!, r]));
  const byDid = new Map(repos.map((r) => [r.did, r]));
  let nextRkey = 0;

  const authedRepo = (init: RequestInit | undefined): FakeRepo | null => {
    const header = new Headers(init?.headers).get("authorization") ?? "";
    const match = /^Bearer jwt-(.+)$/.exec(header);
    return match !== null ? (byDid.get(match[1]!) ?? null) : null;
  };

  const jsonBody = (init: RequestInit | undefined): Record<string, unknown> => {
    try {
      return JSON.parse(String(init?.body)) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  const fetcher: Fetcher = async (input, init) => {
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

    if (path.endsWith("/xrpc/com.atproto.server.createSession")) {
      const body = jsonBody(init);
      const identifier = typeof body["identifier"] === "string" ? body["identifier"] : "";
      const repo = byHandle.get(identifier) ?? byDid.get(identifier);
      if (!repo || repo.password === undefined || body["password"] !== repo.password) {
        return unauthorized();
      }
      return json({
        did: repo.did,
        handle: repo.handle ?? "",
        accessJwt: `jwt-${repo.did}`,
        refreshJwt: `refresh-${repo.did}`,
      });
    }

    if (path.endsWith("/xrpc/com.atproto.repo.uploadBlob")) {
      const repo = authedRepo(init);
      if (!repo) return unauthorized();
      const bytes = new Uint8Array(init?.body as Uint8Array);
      const cid = fakeBlobCid(bytes);
      blobs.set(cid, bytes);
      const mimeType = new Headers(init?.headers).get("content-type") ?? "";
      return json({
        blob: { $type: "blob", ref: { $link: cid }, mimeType, size: bytes.length },
      });
    }

    if (path.endsWith("/xrpc/com.atproto.repo.createRecord")) {
      const repo = authedRepo(init);
      if (!repo) return unauthorized();
      const body = jsonBody(init);
      const collection = String(body["collection"] ?? "");
      const record = (body["record"] ?? {}) as Record<string, unknown>;
      const rkey = `3lfake${String(++nextRkey).padStart(7, "0")}`;
      (repo.collections[collection] ??= []).unshift({ rkey, value: record });
      const uri = `at://${repo.did}/${collection}/${rkey}`;
      records.set(uri, record);
      return json({ uri, cid: `bafy${rkey}` });
    }

    if (path.endsWith("/xrpc/com.atproto.repo.putRecord")) {
      const repo = authedRepo(init);
      if (!repo) return unauthorized();
      const body = jsonBody(init);
      const collection = String(body["collection"] ?? "");
      const rkey = String(body["rkey"] ?? "");
      const record = (body["record"] ?? {}) as Record<string, unknown>;
      const existing = (repo.collections[collection] ??= []);
      const slot = existing.find((r) => r.rkey === rkey);
      if (slot !== undefined) slot.value = record;
      else existing.unshift({ rkey, value: record });
      const uri = `at://${repo.did}/${collection}/${rkey}`;
      records.set(uri, record);
      return json({ uri, cid: `bafy${rkey}-put` });
    }

    if (path.endsWith("/xrpc/com.atproto.repo.deleteRecord")) {
      const repo = authedRepo(init);
      if (!repo) return unauthorized();
      const body = jsonBody(init);
      const collection = String(body["collection"] ?? "");
      const rkey = String(body["rkey"] ?? "");
      const existing = repo.collections[collection] ?? [];
      repo.collections[collection] = existing.filter((r) => r.rkey !== rkey);
      const uri = `at://${repo.did}/${collection}/${rkey}`;
      records.delete(uri);
      deleted.push(uri);
      return json({});
    }

    return json({ error: "NotImplemented", path }, 404);
  };

  // Everything in the fake network is "public" unless a test says otherwise.
  const dnsLookup: Lookup = async () => ["93.184.216.34"];

  return { fetcher, dnsLookup, calls, records, blobs, deleted };
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
