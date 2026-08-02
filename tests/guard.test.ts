import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/build.js";
import { writeSourceCache, CACHE_VERSION } from "../src/cache.js";
import { parseConfig, type Config } from "../src/config.js";
import {
  GuardError,
  hasErrors,
  inspect,
  readManifest,
  SHRINK_THRESHOLD,
  type BuildManifest,
} from "../src/guard.js";
import { loadSite, type SiteModel } from "../src/site.js";
import type { RawRecord } from "../src/repo.js";

const DID = "did:plc:test";

const doc = (n: number, extra: Record<string, unknown> = {}): RawRecord => ({
  uri: `at://${DID}/site.standard.document/3k${n}`,
  cid: `bafy${n}`,
  rkey: `3k${n}`,
  value: {
    title: `Post ${n}`,
    path: `/p${n}`,
    publishedAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`,
    textContent: "b",
    ...extra,
  },
});

async function project(records: RawRecord[], sources = 1): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "atmo-guard-"));
  const extra = sources > 1 ? '\n[[source]]\nname = "second"\nhandle = "b.example.com"\n' : "";
  const config = {
    ...parseConfig(`
[site]
title = "T"
base_url = "https://example.com"

[[source]]
name = "posts"
handle = "you.example.com"
${extra}
`),
    cache_dir: join(dir, "cache"),
    out_dir: join(dir, "out"),
  };
  await writeSourceCache(config.cache_dir, {
    version: CACHE_VERSION,
    source: "posts",
    did: DID,
    pdsUrl: "https://pds.example",
    fetchedAt: "2026-07-01T00:00:00.000Z",
    collections: { "site.standard.document": records },
    blobs: [],
  });
  return config;
}

const model = (over: Partial<SiteModel>): SiteModel =>
  ({
    pages: [],
    publicPages: [],
    collections: [],
    tags: [],
    index: [],
    blobs: [],
    missingSources: [],
    skipped: 0,
    ...over,
  }) as SiteModel;

describe("inspect", () => {
  it("errors on a source with no cache", () => {
    const findings = inspect(model({ missingSources: ["private"] }));
    expect(findings[0]).toMatchObject({ severity: "error", code: "missing-source" });
    expect(hasErrors(findings)).toBe(true);
  });

  it("errors on a site with nothing in it", () => {
    expect(inspect(model({})).some((f) => f.code === "empty-site")).toBe(true);
  });

  it("accepts an empty document set when a collection exists", () => {
    const findings = inspect(model({ collections: [{}] as never }));
    expect(findings.some((f) => f.code === "empty-site")).toBe(false);
  });

  // The failure this whole module exists for.
  it("errors when the page count collapses versus the last build", () => {
    const previous: BuildManifest = {
      builtAt: "2026-06-01T00:00:00Z",
      pages: 100,
      publicPages: 100,
      collections: 0,
    };
    const findings = inspect(model({ pages: [{}] as never }), { previous });
    expect(findings.some((f) => f.code === "shrink")).toBe(true);
  });

  it("allows a shrink below the threshold", () => {
    const previous: BuildManifest = {
      builtAt: "x",
      pages: 10,
      publicPages: 10,
      collections: 0,
    };
    const pages = Array.from({ length: 10 - Math.floor(10 * SHRINK_THRESHOLD) + 1 });
    const findings = inspect(model({ pages: pages as never }), { previous });
    expect(findings.some((f) => f.code === "shrink")).toBe(false);
  });

  it("allows any shrink under force", () => {
    const previous: BuildManifest = { builtAt: "x", pages: 100, publicPages: 100, collections: 0 };
    const findings = inspect(model({ pages: [] }), { previous, force: true });
    expect(hasErrors(findings)).toBe(false);
  });

  it("never treats growth as a shrink", () => {
    const previous: BuildManifest = { builtAt: "x", pages: 1, publicPages: 1, collections: 0 };
    const findings = inspect(model({ pages: [{}, {}, {}] as never }), { previous });
    expect(findings.some((f) => f.code === "shrink")).toBe(false);
  });

  // Warnings, not errors: a human could want these.
  it("warns about skipped records", () => {
    const findings = inspect(model({ pages: [{}] as never, skipped: 3 }));
    expect(findings.find((f) => f.code === "skipped-records")).toMatchObject({
      severity: "warning",
    });
    expect(hasErrors(findings)).toBe(false);
  });

  it("warns about an untitled document", () => {
    const page = { doc: { title: "  ", rkey: "3ka" } };
    const findings = inspect(model({ pages: [page] as never, publicPages: [page] as never }));
    expect(findings.find((f) => f.code === "untitled")).toMatchObject({ severity: "warning" });
  });

  it("sorts errors before warnings", () => {
    const findings = inspect(model({ missingSources: ["x"], skipped: 1 }));
    expect(findings[0]!.severity).toBe("error");
    expect(findings.at(-1)!.severity).toBe("warning");
  });
});

describe("build guards", () => {
  it("writes a manifest after a good build", async () => {
    const config = await project([doc(1), doc(2)]);
    await build(config, { now: () => new Date("2026-07-01T00:00:00Z") });

    const manifest = await readManifest(config.cache_dir);
    expect(manifest).toMatchObject({
      pages: 2,
      publicPages: 2,
      builtAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("refuses a collapsed build and leaves the previous output intact", async () => {
    const config = await project([doc(1), doc(2), doc(3), doc(4)]);
    await build(config);
    const before = await readFile(join(config.out_dir, "posts", "p1", "index.html"), "utf8");

    // A transient PDS error: the cache now has almost nothing in it.
    await writeSourceCache(config.cache_dir, {
      version: CACHE_VERSION,
      source: "posts",
      did: DID,
      pdsUrl: "https://pds.example",
      fetchedAt: "2026-07-02T00:00:00.000Z",
      collections: { "site.standard.document": [doc(1)] },
      blobs: [],
    });

    await expect(build(config)).rejects.toThrow(GuardError);

    // The point: the deployed site is untouched.
    const after = await readFile(join(config.out_dir, "posts", "p1", "index.html"), "utf8");
    expect(after).toBe(before);
    await expect(
      readFile(join(config.out_dir, "posts", "p4", "index.html"), "utf8"),
    ).resolves.toBeTruthy();
  });

  it("publishes the collapsed build under force", async () => {
    const config = await project([doc(1), doc(2), doc(3), doc(4)]);
    await build(config);
    await writeSourceCache(config.cache_dir, {
      version: CACHE_VERSION,
      source: "posts",
      did: DID,
      pdsUrl: "https://pds.example",
      fetchedAt: "2026-07-02T00:00:00.000Z",
      collections: { "site.standard.document": [doc(1)] },
      blobs: [],
    });

    await expect(build(config, { force: true })).resolves.toBeTruthy();
    await expect(
      readFile(join(config.out_dir, "posts", "p4", "index.html"), "utf8"),
    ).rejects.toThrow();
  });

  it("refuses when a configured source was never pulled", async () => {
    const config = await project([doc(1)], 2);
    await expect(build(config)).rejects.toThrow(/second/);
  });

  it("refuses an entirely empty site", async () => {
    const config = await project([]);
    await expect(build(config)).rejects.toThrow(/empty site/);
  });

  it("reports skipped records on the model", async () => {
    const bad = { ...doc(2), value: { title: "no timestamp" } };
    const config = await project([doc(1), bad]);
    const site = await loadSite(config);
    expect(site.skipped).toBe(1);
  });

  it("does not write a manifest for a refused build", async () => {
    const config = await project([]);
    await rm(join(config.cache_dir, "build-manifest.json"), { force: true });
    await expect(build(config)).rejects.toThrow();
    await expect(readManifest(config.cache_dir)).resolves.toBeNull();
  });
});
