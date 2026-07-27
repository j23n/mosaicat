import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/build.js";
import { writeSourceCache, CACHE_VERSION } from "../src/cache.js";
import {
  collectItems,
  collectionHeading,
  parseItem,
  templateCandidates,
} from "../src/collection.js";
import { parseConfig, type Config } from "../src/config.js";
import { createRenderer } from "../src/render.js";
import { loadSite } from "../src/site.js";
import type { RawRecord } from "../src/repo.js";

const DID = "did:plc:test";

const rec = (rkey: string, value: Record<string, unknown>): RawRecord => ({
  uri: `at://${DID}/x/${rkey}`,
  cid: `bafy${rkey}`,
  rkey,
  value,
});

describe("parseItem", () => {
  it("finds a label from common field names", () => {
    expect(parseItem(rec("a", { name: "Tangled" })).label).toBe("Tangled");
    expect(parseItem(rec("b", { title: "A Book" })).label).toBe("A Book");
    expect(parseItem(rec("c", { text: "  spaced  " })).label).toBe("spaced");
  });

  it("falls back to the rkey when nothing looks like a name", () => {
    expect(parseItem(rec("3kabc", { weird: 1 })).label).toBe("3kabc");
  });

  it("finds a date from common field names", () => {
    expect(parseItem(rec("a", { createdAt: "2026-01-01T00:00:00Z" })).at?.getFullYear()).toBe(2026);
    expect(parseItem(rec("b", { nope: "x" })).at).toBeNull();
    expect(parseItem(rec("c", { createdAt: "not a date" })).at).toBeNull();
  });

  it("flattens values into displayable rows and drops $type", () => {
    const item = parseItem(
      rec("a", {
        $type: "sh.tangled.repo",
        name: "atmo",
        tags: ["a", "b"],
        owner: { displayName: "You" },
        blob: { $link: "bafyxyz" },
        empty: null,
        count: 3,
        live: true,
      }),
    );
    const rows = Object.fromEntries(item.fields.map((f) => [f.key, f.value]));

    expect(rows["$type"]).toBeUndefined();
    expect(rows["tags"]).toBe("a, b");
    expect(rows["owner"]).toBe("You");
    expect(rows["blob"]).toBe("bafyxyz");
    expect(rows["count"]).toBe("3");
    expect(rows["live"]).toBe("true");
    expect(rows["empty"]).toBeUndefined();
  });

  // Same posture as branch c: an unfamiliar shape must still render.
  it("never throws on a deeply nested or hostile record", () => {
    const deep = { a: { b: { c: { d: [1, [2, [3]]] } } } };
    expect(() => parseItem(rec("a", deep))).not.toThrow();
    expect(() => parseItem(rec("b", {}))).not.toThrow();
  });
});

describe("collectItems", () => {
  it("puts dated records newest first, undated ones after", () => {
    const items = collectItems([
      rec("a", { name: "old", createdAt: "2020-01-01T00:00:00Z" }),
      rec("b", { name: "undated" }),
      rec("c", { name: "new", createdAt: "2026-01-01T00:00:00Z" }),
    ]);
    expect(items.map((i) => i.label)).toEqual(["new", "old", "undated"]);
  });
});

describe("template registry", () => {
  it("prefers the NSID template, then the default", () => {
    expect(templateCandidates("buzz.bookhive.book")).toEqual([
      "collections/buzz.bookhive.book.eta",
      "collections/default.eta",
    ]);
  });

  it("resolves a known NSID to its own template", () => {
    const renderer = createRenderer(".");
    expect(renderer.findTemplate(templateCandidates("buzz.bookhive.book"))).toBe(
      "collections/buzz.bookhive.book.eta",
    );
  });

  // The payoff: a lexicon nobody wrote a template for still renders.
  it("falls back to the generic template for an unknown NSID", () => {
    const renderer = createRenderer(".");
    expect(renderer.findTemplate(templateCandidates("com.example.invented.tomorrow"))).toBe(
      "collections/default.eta",
    );
  });

  it("builds a readable heading from an NSID", () => {
    expect(collectionHeading("sh.tangled.repo")).toBe("Repo");
    expect(collectionHeading("buzz.bookhive.book")).toBe("Book");
  });
});

async function project(collections: Record<string, RawRecord[]>, extra = ""): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "atmo-coll-"));
  const config = {
    ...parseConfig(`
[site]
title = "Test"
base_url = "https://example.com"

[[source]]
name = "me"
handle = "you.example.com"
collections = ${JSON.stringify(Object.keys(collections))}
${extra}
`),
    cache_dir: join(dir, "cache"),
    out_dir: join(dir, "out"),
  };
  await writeSourceCache(config.cache_dir, {
    version: CACHE_VERSION,
    source: "me",
    did: DID,
    pdsUrl: "https://pds.example",
    fetchedAt: "2026-07-01T00:00:00.000Z",
    collections,
    blobs: [],
  });
  return config;
}

describe("collections end to end", () => {
  it("renders a known lexicon with its own template", async () => {
    const config = await project({
      "buzz.bookhive.book": [
        rec("1", { title: "Piranesi", authors: "Susanna Clarke", status: "finished#read" }),
      ],
    });
    await build(config);
    const html = await readFile(
      join(config.out_dir, "me", "buzz.bookhive.book", "index.html"),
      "utf8",
    );

    expect(html).toContain("Piranesi");
    expect(html).toContain("Susanna Clarke");
    expect(html).toContain("book-list");
  });

  it("renders an invented lexicon through the generic template", async () => {
    const config = await project({
      "com.example.scrobble": [
        rec("1", { track: "Blue Monday", playedAt: "2026-05-01T00:00:00Z" }),
      ],
    });
    await build(config);
    const html = await readFile(
      join(config.out_dir, "me", "com.example.scrobble", "index.html"),
      "utf8",
    );

    expect(html).toContain("com.example.scrobble");
    expect(html).toContain("Blue Monday");
    expect(html).toContain("record-fields");
  });

  it("keeps documents out of the collection pages", async () => {
    const config = await project({
      "site.standard.document": [
        rec("1", { title: "A post", publishedAt: "2026-01-01T00:00:00Z" }),
      ],
      "sh.tangled.repo": [rec("2", { name: "atmo" })],
    });
    const site = await loadSite(config);

    expect(site.collections.map((c) => c.nsid)).toEqual(["sh.tangled.repo"]);
    expect(site.pages).toHaveLength(1);
  });

  it("does not emit collection pages for an encrypted source", async () => {
    const config = await project(
      { "sh.tangled.repo": [rec("1", { name: "secret" })] },
      'visibility = "encrypted"',
    );
    const site = await loadSite(config);
    expect(site.collections).toEqual([]);
  });

  it("lets a project override a collection template", async () => {
    const config = await project({ "sh.tangled.repo": [rec("1", { name: "atmo" })] });
    const root = join(config.out_dir, "..", "proj");
    await mkdir(join(root, "templates", "collections"), { recursive: true });
    await writeFile(
      join(root, "templates", "collections", "sh.tangled.repo.eta"),
      "<p>OVERRIDDEN <%= it.items.length %></p>",
    );

    await build(config, { projectRoot: root });
    const html = await readFile(
      join(config.out_dir, "me", "sh.tangled.repo", "index.html"),
      "utf8",
    );
    expect(html).toContain("OVERRIDDEN 1");
  });
});
