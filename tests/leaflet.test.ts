import { describe, expect, it } from "vitest";
import { contentCids } from "../src/blob.js";
import { facetedText, leafletContent } from "../src/leaflet.js";

const text = (plaintext: string, facets?: unknown) => ({
  $type: "pub.leaflet.blocks.text",
  plaintext,
  ...(facets !== undefined ? { facets } : {}),
});

const block = (kind: string, fields: Record<string, unknown> = {}) => ({
  $type: `pub.leaflet.blocks.${kind}`,
  ...fields,
});

/** Wrap blocks the way Leaflet writes them: one linearDocument page. */
const content = (...blocks: unknown[]) => ({
  $type: "pub.leaflet.content",
  pages: [
    {
      $type: "pub.leaflet.pages.linearDocument",
      blocks: blocks.map((b) => ({ block: b })),
    },
  ],
});

const facet = (byteStart: number, byteEnd: number, ...features: unknown[]) => ({
  index: { byteStart, byteEnd },
  features,
});

const feature = (kind: string, fields: Record<string, unknown> = {}) => ({
  $type: `pub.leaflet.richtext.facet#${kind}`,
  ...fields,
});

describe("leafletContent detection", () => {
  it("renders a declared pub.leaflet.content", () => {
    const body = leafletContent(content(text("Hello.")))!;
    expect(body.html).toBe("<p>Hello.</p>");
    expect(body.text).toBe("Hello.");
  });

  it("renders an undeclared shape with object pages", () => {
    const shape = { pages: [{ blocks: [{ block: text("Hi") }] }] };
    expect(leafletContent(shape)?.html).toBe("<p>Hi</p>");
  });

  // The back-compat contract from branch `c`: an unknown union variant that
  // merely resembles a block document must fall through to textContent.
  it.each([
    ["future block shape", { $type: "some.future.block", blocks: [1, 2] }],
    ["a bare string", "just markdown"],
    ["a markdown block", { markdown: "# Hi" }],
    ["null", null],
    ["a number", 42],
    ["pages of non-objects", { pages: [1, 2] }],
    ["empty pages", { $type: "pub.leaflet.content", pages: [] }],
    ["no pages at all", { $type: "pub.leaflet.content" }],
  ])("returns null for %s", (_label, shape) => {
    expect(leafletContent(shape)).toBeNull();
  });

  it("returns null when blobPages is set", () => {
    const shape = { ...content(text("inline")), blobPages: [{}] };
    expect(leafletContent(shape)).toBeNull();
  });

  it("returns null when every block was skipped", () => {
    const shape = content(block("bskyPost", { uri: "at://x" }), block("poll"));
    expect(leafletContent(shape)).toBeNull();
  });
});

describe("leafletContent blocks", () => {
  it("renders headers clamped to h2..h6", () => {
    const body = leafletContent(
      content(
        block("header", { plaintext: "One", level: 1 }),
        block("header", { plaintext: "Deep", level: 6 }),
        block("header", { plaintext: "Default" }),
      ),
    )!;
    expect(body.html).toContain("<h2>One</h2>");
    expect(body.html).toContain("<h6>Deep</h6>");
    expect(body.html).toContain("<h2>Default</h2>");
  });

  it("renders a blockquote", () => {
    expect(leafletContent(content(block("blockquote", { plaintext: "Q" })))!.html).toBe(
      "<blockquote><p>Q</p></blockquote>",
    );
  });

  it("renders code with a language class only when the language is sane", () => {
    const ok = leafletContent(content(block("code", { plaintext: "x", language: "ts" })))!;
    expect(ok.html).toBe('<pre><code class="language-ts">x</code></pre>');

    const evil = leafletContent(
      content(block("code", { plaintext: "x", language: '"><script>' })),
    )!;
    expect(evil.html).toBe("<pre><code>x</code></pre>");
  });

  it("renders a horizontal rule", () => {
    expect(leafletContent(content(block("horizontalRule")))!.html).toBe("<hr />");
  });

  it("renders an image as an atproto getBlob placeholder", () => {
    const body = leafletContent(
      content(
        block("image", {
          image: { ref: { $link: "bafyimg" }, mimeType: "image/png" },
          alt: "A cat",
        }),
      ),
    )!;
    expect(body.html).toBe('<img src="atproto://getBlob?cid=bafyimg" alt="A cat" />');
    // The seam: pull discovers this CID through the same regex.
    expect(contentCids(body.html)).toEqual(["bafyimg"]);
  });

  it("renders nested lists", () => {
    const body = leafletContent(
      content(
        block("unorderedList", {
          children: [
            { content: text("a"), children: [{ content: text("a1") }] },
            { content: text("b") },
          ],
        }),
      ),
    )!;
    expect(body.html).toBe("<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>");
    expect(body.text).toContain("a1");
  });

  it("renders an ordered list as ol", () => {
    const body = leafletContent(
      content(block("orderedList", { children: [{ content: text("one") }] })),
    )!;
    expect(body.html).toBe("<ol><li>one</li></ol>");
  });

  it("caps list recursion instead of overflowing", () => {
    let child: Record<string, unknown> = { content: text("deep") };
    for (let i = 0; i < 50; i++) child = { content: text("x"), children: [child] };
    const shape = content(block("unorderedList", { children: [child] }));
    expect(() => leafletContent(shape)).not.toThrow();
  });

  it.each([
    "iframe",
    "html",
    "bskyPost",
    "website",
    "poll",
    "button",
    "postsList",
    "signup",
    "math",
    "page",
    "membersOnlyDelimiter",
    "someFutureBlock",
  ])("skips a %s block quietly", (kind) => {
    const body = leafletContent(content(text("kept"), block(kind, { plaintext: "lost" })))!;
    expect(body.html).toBe("<p>kept</p>");
  });

  it("joins plaintext contributions for excerpts", () => {
    const body = leafletContent(
      content(text("First."), block("header", { plaintext: "Head" }), text("Second.")),
    )!;
    expect(body.text).toBe("First.\n\nHead\n\nSecond.");
  });

  it("escapes hostile plaintext", () => {
    const body = leafletContent(content(text("<script>alert(1)</script>")))!;
    expect(body.html).not.toContain("<script>");
    expect(body.html).toContain("&lt;script&gt;");
  });

  it("never throws on garbage block entries", () => {
    const shape = {
      $type: "pub.leaflet.content",
      pages: [{ blocks: [null, 42, "x", { block: null }, { block: { $type: 7 } }, {}] }, {}],
    };
    expect(() => leafletContent(shape)).not.toThrow();
  });
});

describe("facetedText", () => {
  it("applies inline formatting features", () => {
    expect(facetedText("bold", [facet(0, 4, feature("bold"))])).toBe("<strong>bold</strong>");
    expect(facetedText("it", [facet(0, 2, feature("italic"))])).toBe("<em>it</em>");
    expect(facetedText("c", [facet(0, 1, feature("code"))])).toBe("<code>c</code>");
    expect(facetedText("s", [facet(0, 1, feature("strikethrough"))])).toBe("<del>s</del>");
    expect(facetedText("u", [facet(0, 1, feature("underline"))])).toBe("<u>u</u>");
    expect(facetedText("h", [facet(0, 1, feature("highlight"))])).toBe("<mark>h</mark>");
  });

  it("stacks multiple features on one facet", () => {
    expect(facetedText("x", [facet(0, 1, feature("bold"), feature("italic"))])).toBe(
      "<em><strong>x</strong></em>",
    );
  });

  it("links http(s) URIs and drops other schemes", () => {
    expect(facetedText("go", [facet(0, 2, feature("link", { uri: "https://a.example/" }))])).toBe(
      '<a href="https://a.example/">go</a>',
    );
    expect(facetedText("go", [facet(0, 2, feature("link", { uri: "javascript:alert(1)" }))])).toBe(
      "go",
    );
  });

  it("links a didMention to the bsky profile", () => {
    expect(facetedText("@p", [facet(0, 2, feature("didMention", { did: "did:plc:abc" }))])).toBe(
      '<a href="https://bsky.app/profile/did:plc:abc">@p</a>',
    );
  });

  it.each(["footnote", "id", "atMention", "someFutureFeature"])(
    "keeps the text and drops a %s feature",
    (kind) => {
      expect(facetedText("plain", [facet(0, 5, feature(kind))])).toBe("plain");
    },
  );

  // The offsets are UTF-8 bytes, not JS string indices. "😀 " is five bytes
  // (the emoji alone is four) but only three UTF-16 code units.
  it("slices by UTF-8 bytes, not string indices", () => {
    expect(facetedText("😀 bold", [facet(5, 9, feature("bold"))])).toBe("😀 <strong>bold</strong>");
    expect(facetedText("café x", [facet(6, 7, feature("bold"))])).toBe("café <strong>x</strong>");
  });

  it("drops invalid, reversed, and overlapping facets", () => {
    const html = facetedText("abcdef", [
      facet(4, 2, feature("bold")), // reversed
      facet(-1, 3, feature("bold")), // negative
      facet(0, 99, feature("bold")), // past the end
      facet(0, 3, feature("bold")),
      facet(2, 5, feature("italic")), // overlaps the previous — first wins
    ]);
    expect(html).toBe("<strong>abc</strong>def");
  });

  it("escapes hostile text inside and outside facets", () => {
    const html = facetedText("<b> & <i>", [facet(0, 3, feature("bold"))]);
    expect(html).toBe("<strong>&lt;b&gt;</strong> &amp; &lt;i&gt;");
  });

  it("never throws on garbage facets", () => {
    for (const junk of [
      null,
      "x",
      42,
      [null, "y", { index: null }, { index: { byteStart: "a" } }],
    ]) {
      expect(() => facetedText("text", junk)).not.toThrow();
      expect(facetedText("text", junk)).toBe("text");
    }
  });

  it("survives a facet boundary inside a multibyte character", () => {
    // Byte 1 splits the emoji; the decoder substitutes rather than throwing.
    expect(() => facetedText("😀x", [facet(1, 5, feature("bold"))])).not.toThrow();
  });
});
