import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { writeSourceCache, CACHE_VERSION } from "../src/cache.js";
import { parseConfig, type Config } from "../src/config.js";
import { build } from "../src/build.js";
import { renderFeed, renderRobots, renderSitemap } from "../src/feed.js";
import {
  excerpt,
  renderBody,
  renderHtml,
  renderMarkdown,
  renderPlainText,
} from "../src/markdown.js";
import { loadSite } from "../src/site.js";
import type { RawRecord } from "../src/repo.js";

const DID = "did:plc:test";

const doc = (n: number, extra: Record<string, unknown> = {}): RawRecord => ({
  uri: `at://${DID}/site.standard.document/3k${n}`,
  cid: `bafy${n}`,
  rkey: `3k${n}`,
  value: {
    title: `Post ${n}`,
    path: `/post-${n}`,
    publishedAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`,
    textContent: `Body ${n}.`,
    ...extra,
  },
});

/** One record of a non-document collection, for nav and sitemap cases. */
const status = (): RawRecord => ({
  uri: `at://${DID}/xyz.statusphere.status/3ks`,
  cid: "bafys",
  rkey: "3ks",
  value: { status: "excited", createdAt: "2026-01-05T00:00:00Z" },
});

interface ProjectExtras {
  toml?: string;
  /** Cache collections beyond the documents. */
  collections?: Record<string, RawRecord[]>;
  blobs?: { cid: string; mimeType: string; bytes: number }[];
}

async function project(records: RawRecord[], extras: ProjectExtras = {}): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "atmo-build-"));
  const config = {
    ...parseConfig(`
[site]
title = "Test Site"
base_url = "https://example.com"
description = "A test."

[[source]]
name = "posts"
handle = "you.example.com"
${extras.toml ?? ""}
`),
    cache_dir: join(dir, "cache"),
    out_dir: join(dir, "out"),
  };
  await writeSourceCache(config.cache_dir, {
    version: CACHE_VERSION,
    source: "posts",
    did: DID,
    pdsUrl: "https://pds.example.com",
    fetchedAt: "2026-07-01T00:00:00.000Z",
    collections: { "site.standard.document": records, ...(extras.collections ?? {}) },
    blobs: extras.blobs ?? [],
  });
  return config;
}

const read = (config: Config, path: string) => readFile(join(config.out_dir, path), "utf8");

describe("markdown", () => {
  it("renders gfm", () => {
    expect(renderMarkdown("# Hi\n\n- a\n- b")).toContain("<h1>Hi</h1>");
    expect(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).toContain("<table>");
  });

  // The body came out of a record. Someone else wrote it.
  it.each([
    ["<script>alert(1)</script>", "script"],
    ['<img src=x onerror="alert(1)">', "onerror"],
    ['<a href="javascript:alert(1)">x</a>', "javascript:"],
    ['<iframe src="https://evil.test"></iframe>', "iframe"],
    ["<style>body{display:none}</style>", "<style"],
  ])("strips %s", (input, forbidden) => {
    expect(renderMarkdown(input).toLowerCase()).not.toContain(forbidden.toLowerCase());
  });

  it("keeps safe links and adds noreferrer", () => {
    const html = renderMarkdown("[x](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("noreferrer");
  });

  it("escapes plain text rather than rendering it", () => {
    expect(renderPlainText("<b>not bold</b>")).toContain("&lt;b&gt;");
  });

  it("routes by format", () => {
    expect(renderBody("# H", "markdown")).toContain("<h1>");
    expect(renderBody("# H", "text")).toContain("<p># H</p>");
    expect(renderBody("<p>H</p>", "html")).toBe("<p>H</p>");
  });

  // Leaflet bodies arrive pre-rendered; the sanitizer still gets the last word.
  it("sanitizes pre-rendered html", () => {
    expect(renderHtml('<p>ok</p><script>alert(1)</script><img src=x onerror="x">')).not.toContain(
      "script",
    );
    expect(renderHtml("<p>ok</p><u>u</u><mark>m</mark>")).toBe("<p>ok</p><u>u</u><mark>m</mark>");
  });

  it("builds an excerpt without markup", () => {
    expect(excerpt("# Title\n\nSome **bold** text.")).toBe("Title Some bold text.");
    expect(excerpt("a ".repeat(300), 50).endsWith("…")).toBe(true);
  });
});

describe("site model", () => {
  it("orders pages newest first and paginates", async () => {
    const config = await project([doc(1), doc(2), doc(3)]);
    const site = await loadSite({ ...config, page_size: 2 });

    expect(site.pages.map((p) => p.doc.title)).toEqual(["Post 3", "Post 2", "Post 1"]);
    expect(site.index).toHaveLength(2);
    expect(site.index[0]!.url).toBe("/");
    expect(site.index[1]!.url).toBe("/page/2/");
    expect(site.index[0]!.nextUrl).toBe("/page/2/");
    expect(site.index[1]!.previousUrl).toBe("/");
  });

  it("derives urls from the source name by default", async () => {
    const config = await project([doc(1)]);
    const site = await loadSite(config);
    expect(site.pages[0]!.url).toBe("/posts/post-1/");
  });

  it("honours an explicit path_prefix", async () => {
    const config = await project([doc(1)], { toml: 'path_prefix = "/writing"' });
    const site = await loadSite(config);
    expect(site.pages[0]!.url).toBe("/writing/post-1/");
  });

  it("groups tags and falls back to an excerpt for the summary", async () => {
    const config = await project([doc(1, { tags: ["Zed", "Alpha"] }), doc(2, { tags: ["alpha"] })]);
    const site = await loadSite(config);

    expect(site.tags.map((t) => t.tag.slug)).toEqual(["alpha", "zed"]);
    expect(site.tags[0]!.pages).toHaveLength(2);
    expect(site.pages[0]!.summary).toBe("Body 2.");
  });

  it("records a source with no cache instead of throwing", async () => {
    const config = await project([doc(1)]);
    const site = await loadSite({
      ...config,
      source: [...config.source, { ...config.source[0]!, name: "absent" }],
    });
    expect(site.missingSources).toEqual(["absent"]);
  });

  it("produces a valid empty model for an empty repo", async () => {
    const config = await project([]);
    const site = await loadSite(config);
    expect(site.pages).toEqual([]);
    expect(site.index).toHaveLength(1);
  });
});

describe("build", () => {
  let config: Config;
  beforeEach(async () => {
    config = await project([doc(1, { tags: ["notes"] }), doc(2)]);
  });

  it("writes index, posts, tags, feed, sitemap, robots and css", async () => {
    const { written } = await build(config);
    expect(written).toEqual(
      expect.arrayContaining([
        "/index.html",
        "/posts/post-1/index.html",
        "/posts/post-2/index.html",
        "/tags/notes/index.html",
        "/feed.xml",
        "/sitemap.xml",
        "/robots.txt",
        "/assets/atmo.css",
      ]),
    );
  });

  it("renders a post page with its body and canonical link", async () => {
    await build(config);
    const html = await read(config, "posts/post-2/index.html");
    expect(html).toContain("Post 2");
    expect(html).toContain("Body 2.");
    expect(html).toContain('rel="canonical" href="https://example.com/posts/post-2/"');
    expect(html).toContain('<link rel="stylesheet" href="/assets/atmo.css" />');
  });

  it("lists posts newest first on the index", async () => {
    await build(config);
    const html = await read(config, "index.html");
    expect(html.indexOf("Post 2")).toBeLessThan(html.indexOf("Post 1"));
  });

  // A stale file from a deleted post would otherwise be served forever.
  it("clears the output directory first", async () => {
    await build(config);
    const fewer = { ...config };
    await writeSourceCache(fewer.cache_dir, {
      version: CACHE_VERSION,
      source: "posts",
      did: DID,
      pdsUrl: "https://pds.example.com",
      fetchedAt: "2026-07-02T00:00:00.000Z",
      collections: { "site.standard.document": [doc(1, { tags: ["notes"] })] },
      blobs: [],
    });
    // Deliberate shrink, so it needs --force once branch `h` guards land.
    await build(fewer, { force: true });
    await expect(read(fewer, "posts/post-2/index.html")).rejects.toThrow();
  });

  it("escapes a hostile title rather than emitting it", async () => {
    const hostile = await project([doc(1, { title: "<script>alert(1)</script>" })]);
    await build(hostile);
    const html = await read(hostile, "index.html");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a cover image on the post page and as og:image", async () => {
    const withCover = await project(
      [doc(1, { coverImage: { ref: { $link: "bafyimg" }, mimeType: "image/png" } })],
      { blobs: [{ cid: "bafyimg", mimeType: "image/png", bytes: 3 }] },
    );
    await build(withCover);
    const html = await read(withCover, "posts/post-1/index.html");
    expect(html).toContain('class="post-cover"');
    expect(html).toContain('src="/assets/blobs/bafyimg.png"');
    expect(html).toContain(
      '<meta property="og:image" content="https://example.com/assets/blobs/bafyimg.png" />',
    );
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it("emits neither cover figure nor og:image without a cover", async () => {
    await build(config);
    const html = await read(config, "posts/post-1/index.html");
    expect(html).not.toContain("post-cover");
    expect(html).not.toContain("og:image");
  });

  // The whole leaflet chain at once: parse -> sanitize -> blob URL rewrite.
  it("builds a leaflet document with facets and a local image", async () => {
    const content = {
      $type: "pub.leaflet.content",
      pages: [
        {
          $type: "pub.leaflet.pages.linearDocument",
          blocks: [
            {
              block: {
                $type: "pub.leaflet.blocks.text",
                plaintext: "Hello bold world.",
                facets: [
                  {
                    index: { byteStart: 6, byteEnd: 10 },
                    features: [{ $type: "pub.leaflet.richtext.facet#bold" }],
                  },
                ],
              },
            },
            {
              block: {
                $type: "pub.leaflet.blocks.image",
                image: { ref: { $link: "bafyimg" }, mimeType: "image/png" },
                alt: "pic",
              },
            },
          ],
        },
      ],
    };
    const { textContent: _omit, ...value } = doc(1).value as Record<string, unknown>;
    const leaflet = await project([{ ...doc(1), value: { ...value, content } }], {
      blobs: [{ cid: "bafyimg", mimeType: "image/png", bytes: 3 }],
    });
    await build(leaflet);

    const html = await read(leaflet, "posts/post-1/index.html");
    expect(html).toContain("Hello <strong>bold</strong> world.");
    expect(html).toContain('src="/assets/blobs/bafyimg.png"');

    // The feed sees the plaintext shadow, not the HTML.
    const feed = await read(leaflet, "feed.xml");
    expect(feed).toContain("<description>Hello bold world.</description>");
  });

  it("links collections from a site nav when there are any", async () => {
    const withStatus = await project([doc(1)], {
      collections: { "xyz.statusphere.status": [status()] },
    });
    await build(withStatus);
    const index = await read(withStatus, "index.html");
    expect(index).toContain('class="site-nav"');
    expect(index).toContain('href="/posts/xyz.statusphere.status/"');
    expect(index).toContain("Status");
    // Every public page carries it, including the collection page itself.
    expect(await read(withStatus, "posts/post-1/index.html")).toContain('class="site-nav"');
    expect(await read(withStatus, "posts/xyz.statusphere.status/index.html")).toContain(
      'class="site-nav"',
    );
  });

  it("emits no nav for a posts-only site", async () => {
    await build(config);
    expect(await read(config, "index.html")).not.toContain("site-nav");
  });
});

describe("feeds", () => {
  it("emits items with absolute urls", async () => {
    const config = await project([doc(1), doc(2)]);
    const site = await loadSite(config);
    const xml = renderFeed(site);

    expect(xml).toContain("<title>Test Site</title>");
    expect(xml).toContain("<link>https://example.com/posts/post-2/</link>");
    expect(xml.match(/<item>/g)).toHaveLength(2);
  });

  it("lists index, posts and tags in the sitemap", async () => {
    const config = await project([doc(1, { tags: ["x"] })]);
    const site = await loadSite(config);
    const xml = renderSitemap(site);

    expect(xml).toContain("<loc>https://example.com/</loc>");
    expect(xml).toContain("<loc>https://example.com/posts/post-1/</loc>");
    expect(xml).toContain("<loc>https://example.com/tags/x/</loc>");
  });

  // The private prefix must never be advertised.
  it("disallows /p/ in robots.txt and points at the sitemap", async () => {
    const config = await project([doc(1)]);
    const site = await loadSite(config);
    const robots = renderRobots(site);

    expect(robots).toContain("Disallow: /p/");
    expect(robots).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("excludes encrypted sources from feed and sitemap", async () => {
    const config = await project([doc(1)], { toml: 'visibility = "encrypted"' });
    const site = await loadSite(config);

    expect(site.pages).toHaveLength(1);
    expect(site.publicPages).toHaveLength(0);
    expect(renderFeed(site)).not.toContain("<item>");
    expect(renderSitemap(site)).not.toContain("/posts/post-1/");
  });

  it("lists collection pages in the sitemap", async () => {
    const config = await project([doc(1)], {
      collections: { "xyz.statusphere.status": [status()] },
    });
    const site = await loadSite(config);
    expect(renderSitemap(site)).toContain(
      "<loc>https://example.com/posts/xyz.statusphere.status/</loc>",
    );
  });

  it("keeps an encrypted source's collections out of nav and sitemap", async () => {
    const config = await project([doc(1)], {
      toml: 'visibility = "encrypted"',
      collections: { "xyz.statusphere.status": [status()] },
    });
    const site = await loadSite(config);
    expect(site.collections).toHaveLength(0);
    expect(renderSitemap(site)).not.toContain("statusphere");
  });
});
