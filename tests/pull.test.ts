import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CACHE_VERSION, readSourceCache, type SourceCache } from "../src/cache.js";
import { parseConfig } from "../src/config.js";
import { IdentityError, pdsFromDidDocument, resolveSource } from "../src/identity.js";
import { listRecords } from "../src/repo.js";
import { pull } from "../src/pull.js";
import { documents, fakeNetwork } from "./fake-pds.js";

const DID = "did:plc:testtesttesttesttesttest";
const PDS = "https://pds.example.com";

const repo = (collections: FakeCollections) => ({
  did: DID,
  handle: "you.example.com",
  pdsUrl: PDS,
  collections,
});
type FakeCollections = Record<string, { rkey: string; value: Record<string, unknown> }[]>;

const configFor = (extra = "") =>
  parseConfig(`
[site]
title = "Test"
base_url = "https://example.com"

[[source]]
name = "posts"
handle = "you.example.com"
${extra}
`);

describe("identity", () => {
  it("walks handle -> DID -> PDS", async () => {
    const net = fakeNetwork([repo({})]);
    const identity = await resolveSource(configFor().source[0]!, net);

    expect(identity.did).toBe(DID);
    expect(identity.pdsUrl).toBe(PDS);
    expect(identity.trusted).toBe(false);
    expect(net.calls[0]).toContain("com.atproto.identity.resolveHandle");
    expect(net.calls[1]).toContain(encodeURIComponent(DID));
  });

  it("uses an explicit did + pds_url without any network call", async () => {
    const net = fakeNetwork([]);
    const config = parseConfig(`
[site]
title = "Test"
base_url = "https://example.com"

[[source]]
name = "private"
did = "did:plc:private"
pds_url = "http://pds-private:3000/"
`);
    const identity = await resolveSource(config.source[0]!, net);

    expect(identity.did).toBe("did:plc:private");
    expect(identity.pdsUrl).toBe("http://pds-private:3000"); // slash stripped
    expect(identity.trusted).toBe(true);
    expect(net.calls).toHaveLength(0);
  });

  // The whole point of `trusted`: a resolved endpoint may not be internal.
  it("rejects a resolved PDS on a private address", async () => {
    const net = fakeNetwork([repo({})]);
    await expect(
      resolveSource(configFor().source[0]!, { ...net, dnsLookup: async () => ["10.0.0.1"] }),
    ).rejects.toThrow(IdentityError);
  });

  it("reads the PDS endpoint by service type", () => {
    const doc = {
      service: [
        { id: "#other", type: "Something", serviceEndpoint: "https://wrong.example" },
        { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: `${PDS}/` },
      ],
    };
    expect(pdsFromDidDocument(doc, DID)).toBe(PDS);
  });

  it("raises when the document names no PDS", () => {
    expect(() => pdsFromDidDocument({ service: [] }, DID)).toThrow(/names no PDS/);
  });
});

describe("listRecords", () => {
  const identity = { did: DID, pdsUrl: PDS, trusted: false };

  it("walks the cursor across pages", async () => {
    const net = fakeNetwork([repo({ "site.standard.document": documents(250) })]);
    const records = await listRecords(identity, "site.standard.document", net);

    expect(records).toHaveLength(250);
    expect(net.calls).toHaveLength(3); // 100 + 100 + 50
    expect(records[0]!.uri).toContain("at://");
    expect(records[0]!.rkey).toBe(records[0]!.uri.split("/").pop());
  });

  it("stops at maxRecords rather than draining a huge repo", async () => {
    const net = fakeNetwork([repo({ "site.standard.document": documents(500) })]);
    const records = await listRecords(identity, "site.standard.document", {
      ...net,
      maxRecords: 120,
    });
    expect(records).toHaveLength(120);
  });

  it("returns an empty list for a collection that does not exist", async () => {
    const net = fakeNetwork([repo({})]);
    await expect(listRecords(identity, "nope.nothing.here", net)).resolves.toEqual([]);
  });

  it("skips malformed entries instead of failing the page", async () => {
    const net = fakeNetwork([repo({})]);
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          records: [{ uri: "", cid: "x", value: {} }, { uri: `at://${DID}/c/abc` }],
        }),
        { status: 200 },
      );
    const records = await listRecords(identity, "c", { ...net, fetcher: fetcher as never });

    expect(records).toHaveLength(1);
    expect(records[0]!.value).toEqual({}); // missing value becomes {}, not undefined
  });
});

describe("pull", () => {
  it("writes a readable cache entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atmo-"));
    const net = fakeNetwork([repo({ "site.standard.document": documents(3) })]);
    const config = { ...configFor(), cache_dir: dir };

    const results = await pull(config, { ...net, now: () => new Date("2026-07-01T00:00:00Z") });

    expect(results[0]).toMatchObject({ source: "posts", did: DID, records: 3, blobs: 0 });

    const cache = await readSourceCache(dir, "posts");
    expect(cache?.did).toBe(DID);
    expect(cache?.fetchedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(cache?.collections["site.standard.document"]).toHaveLength(3);

    const onDisk = JSON.parse(await readFile(join(dir, "posts.json"), "utf8")) as SourceCache;
    expect(onDisk.version).toBe(CACHE_VERSION);
  });

  it("treats a cache from a different version as absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atmo-"));
    const net = fakeNetwork([repo({ "site.standard.document": documents(1) })]);
    await pull({ ...configFor(), cache_dir: dir }, net);

    const { writeFile } = await import("node:fs/promises");
    const path = join(dir, "posts.json");
    const cache = JSON.parse(await readFile(path, "utf8")) as SourceCache;
    await writeFile(path, JSON.stringify({ ...cache, version: 99 }));

    await expect(readSourceCache(dir, "posts")).resolves.toBeNull();
  });

  // A partial cache would look complete to `build` and silently drop a section.
  it("aborts the whole pull when one source fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atmo-"));
    const net = fakeNetwork([repo({})]); // second source's handle is unknown
    const config = {
      ...parseConfig(`
[site]
title = "Test"
base_url = "https://example.com"

[[source]]
name = "posts"
handle = "you.example.com"

[[source]]
name = "missing"
handle = "nobody.example.com"
`),
      cache_dir: dir,
    };

    await expect(pull(config, net)).rejects.toThrow(IdentityError);
    await expect(readSourceCache(dir, "missing")).resolves.toBeNull();
  });
});
