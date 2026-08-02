import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/build.js";
import { writeSourceCache, CACHE_VERSION } from "../src/cache.js";
import { parseConfig, type Config } from "../src/config.js";
import { bskyRef, parseDocument } from "../src/document.js";
import type { RawRecord } from "../src/repo.js";

const DID = "did:plc:test";
const BSKY = `at://${DID}/app.bsky.feed.post/3kbsky`;

const rec = (value: Record<string, unknown>): RawRecord => ({
  uri: `at://${DID}/site.standard.document/3ka`,
  cid: "bafya",
  rkey: "3ka",
  value: { title: "P", path: "/p", publishedAt: "2026-01-01T00:00:00Z", ...value },
});

describe("bskyRef", () => {
  it.each([
    ["a bare string", { bskyPostRef: BSKY }],
    ["a strongRef object", { bskyPostRef: { uri: BSKY, cid: "x" } }],
    ["an alternative field name", { bskyPost: BSKY }],
    ["a discussion field", { discussion: { uri: BSKY } }],
  ])("reads %s", (_label, value) => {
    expect(bskyRef(value)).toBe(BSKY);
  });

  it.each([{}, { bskyPostRef: 42 }, { bskyPostRef: "https://bsky.app/x" }, { bskyPostRef: {} }])(
    "returns empty for %s",
    (value) => {
      expect(bskyRef(value)).toBe("");
    },
  );

  it("surfaces on the parsed document", () => {
    expect(parseDocument("s", rec({ bskyPostRef: BSKY }))!.bskyPostUri).toBe(BSKY);
    expect(parseDocument("s", rec({}))!.bskyPostUri).toBe("");
  });
});

async function project(extra = ""): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "atmo-react-"));
  const config = {
    ...parseConfig(`
[site]
title = "T"
base_url = "https://example.com"

${extra}

[[source]]
name = "posts"
handle = "you.example.com"
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
    collections: { "site.standard.document": [rec({ bskyPostRef: BSKY })] },
    blobs: [],
  });
  return config;
}

describe("reactions in the build", () => {
  it("defaults to client mode with the public endpoints", async () => {
    const config = await project();
    expect(config.reactions.mode).toBe("client");
    expect(config.reactions.appview).toBe("https://public.api.bsky.app");
    expect(config.reactions.constellation).toBe("https://constellation.microcosm.blue");
  });

  it("emits the script and a mount point carrying both targets", async () => {
    const config = await project();
    const { written } = await build(config);
    expect(written).toContain("/assets/reactions.js");

    const html = await readFile(join(config.out_dir, "posts", "p", "index.html"), "utf8");
    expect(html).toContain("data-atmo-reactions");
    expect(html).toContain(`data-at-uri="at://${DID}/site.standard.document/3ka"`);
    expect(html).toContain('data-page-url="https://example.com/posts/p/"');
    expect(html).toContain(`data-bsky-uri="${BSKY}"`);
    expect(html).toContain('<script src="/assets/reactions.js" defer></script>');
  });

  // The section is hidden until something is actually rendered into it.
  it("ships the mount point hidden", async () => {
    const config = await project();
    await build(config);
    const html = await readFile(join(config.out_dir, "posts", "p", "index.html"), "utf8");
    expect(html).toMatch(/<section[^>]*\bhidden\b/);
  });

  it("emits nothing when mode is off", async () => {
    const config = await project('[reactions]\nmode = "off"');
    const { written } = await build(config);

    expect(written).not.toContain("/assets/reactions.js");
    const html = await readFile(join(config.out_dir, "posts", "p", "index.html"), "utf8");
    expect(html).not.toContain("data-atmo-reactions");
    expect(html).not.toContain("reactions.js");
  });

  it("honours self-hosted endpoints", async () => {
    const config = await project(
      '[reactions]\nappview = "https://my.appview"\nconstellation = "https://my.index"',
    );
    await build(config);
    const html = await readFile(join(config.out_dir, "posts", "p", "index.html"), "utf8");
    expect(html).toContain('data-appview="https://my.appview"');
    expect(html).toContain('data-constellation="https://my.index"');
  });

  it("ships client code that never uses innerHTML", async () => {
    const config = await project();
    await build(config);
    const js = await readFile(join(config.out_dir, "assets", "reactions.js"), "utf8");

    expect(js).not.toContain("innerHTML");
    expect(js).toContain("textContent");
    // Remote content must not be able to become markup.
    expect(js).toContain('credentials: "omit"');
  });
});
