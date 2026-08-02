import { describe, expect, it } from "vitest";
import {
  asBlobRef,
  belongsToPublication,
  collectDocuments,
  contentMarkdown,
  parseDocument,
  slugFrom,
  slugify,
  type Document,
} from "../src/document.js";
import type { RawRecord } from "../src/repo.js";

const DID = "did:plc:test";

const record = (value: Record<string, unknown>, rkey = "3kaaaaaaaaaaa"): RawRecord => ({
  uri: `at://${DID}/site.standard.document/${rkey}`,
  cid: "bafytest",
  rkey,
  value,
});

const valid = (extra: Record<string, unknown> = {}) => ({
  $type: "site.standard.document",
  title: "Hello",
  path: "/hello-world",
  publishedAt: "2026-03-01T12:00:00Z",
  textContent: "Body.",
  ...extra,
});

describe("slugify", () => {
  it.each([
    ["Hello, World!", "hello-world"],
    ["  spaced  out  ", "spaced-out"],
    ["Café Life", "cafe-life"],
    ["---", ""],
    ["ALLCAPS", "allcaps"],
  ])("%s -> %s", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

describe("parseDocument", () => {
  it("shapes a well-formed record", () => {
    const doc = parseDocument("posts", record(valid({ description: "Sub", tags: ["A", "b"] })))!;
    expect(doc.title).toBe("Hello");
    expect(doc.slug).toBe("hello-world");
    expect(doc.summary).toBe("Sub");
    expect(doc.tags.map((t) => t.slug)).toEqual(["a", "b"]);
    expect(doc.publishedAt.toISOString()).toBe("2026-03-01T12:00:00.000Z");
    expect(doc.updatedAt).toEqual(doc.publishedAt); // defaults to publishedAt
  });

  // The two genuinely required fields.
  it("skips a record with no publishedAt", () => {
    const { publishedAt: _omit, ...rest } = valid();
    expect(parseDocument("posts", record(rest))).toBeNull();
  });

  it("skips a record with an unparseable publishedAt", () => {
    expect(parseDocument("posts", record(valid({ publishedAt: "last tuesday" })))).toBeNull();
  });

  it("skips a record with no rkey", () => {
    expect(parseDocument("posts", { uri: "", cid: "", rkey: "", value: valid() })).toBeNull();
  });

  // Everything else degrades rather than failing.
  it.each([
    ["title", { title: 42 }],
    ["description", { description: [] }],
    ["tags", { tags: "not-a-list" }],
    ["path", { path: { nested: true } }],
    ["coverImage", { coverImage: "nope" }],
    ["site", { site: 99 }],
    ["updatedAt", { updatedAt: "garbage" }],
  ])("survives a junk %s", (_field, override) => {
    const doc = parseDocument("posts", record(valid(override)));
    expect(doc).not.toBeNull();
  });

  it("never throws on arbitrary values", () => {
    const nasties: unknown[] = [null, [], "string", 0, { value: undefined }];
    for (const value of nasties) {
      expect(() =>
        parseDocument("posts", record((value ?? {}) as Record<string, unknown>)),
      ).not.toThrow();
    }
  });

  it("drops non-string and duplicate tags", () => {
    const doc = parseDocument("posts", record(valid({ tags: ["Ok", 3, "", "  ", "ok"] })))!;
    expect(doc.tags).toHaveLength(1);
    expect(doc.tags[0]).toEqual({ name: "Ok", slug: "ok" });
  });
});

describe("content", () => {
  it("prefers markdown over flattened text", () => {
    const doc = parseDocument("posts", record(valid({ content: { markdown: "# Real" } })))!;
    expect(doc.content).toBe("# Real");
    expect(doc.isMarkdown).toBe(true);
  });

  it("falls back to textContent when the block is absent", () => {
    const doc = parseDocument("posts", record(valid()))!;
    expect(doc.content).toBe("Body.");
    expect(doc.isMarkdown).toBe(false);
  });

  // `content` is an open union: an unknown shape must not lose the post.
  it("falls back when the block has a shape we don't know", () => {
    const doc = parseDocument(
      "posts",
      record(valid({ content: { $type: "some.future.block", blocks: [1, 2] } })),
    )!;
    expect(doc.content).toBe("Body.");
  });

  it.each([
    [{ markdown: "m" }, "m"],
    [{ text: "t" }, "t"],
    ["bare string", "bare string"],
    [{ markdown: "   " }, ""],
    [null, ""],
    [42, ""],
  ])("contentMarkdown(%s)", (content, expected) => {
    expect(contentMarkdown({ content })).toBe(expected);
  });
});

describe("blob refs", () => {
  it.each([
    [{ ref: { $link: "bafyabc" }, mimeType: "image/jpeg" }, "bafyabc"],
    [{ ref: "bafyabc" }, "bafyabc"],
  ])("reads %s", (input, cid) => {
    expect(asBlobRef(input)?.cid).toBe(cid);
  });

  it.each([null, "string", {}, { ref: {} }, { ref: { $link: 5 } }])("rejects %s", (input) => {
    expect(asBlobRef(input)).toBeNull();
  });

  it("defaults a missing mime type", () => {
    expect(asBlobRef({ ref: "b" })?.mimeType).toBe("application/octet-stream");
  });
});

describe("slugFrom", () => {
  it.each([
    ["/posts/my-title", "my-title"],
    ["my-title", "my-title"],
    ["/trailing/", "trailing"],
    ["", "3kaaaaaaaaaaa"],
    ["///", "3kaaaaaaaaaaa"],
    [null, "3kaaaaaaaaaaa"],
  ])("%s -> %s", (path, expected) => {
    expect(slugFrom(path, "3kaaaaaaaaaaa")).toBe(expected);
  });
});

describe("belongsToPublication", () => {
  const doc = (site: string) => ({ site }) as Document;

  it("keeps a document claiming the pinned publication", () => {
    expect(
      belongsToPublication(doc(`at://${DID}/site.standard.publication/self`), DID, "self"),
    ).toBe(true);
  });

  it("excludes one claiming a different publication in the same repo", () => {
    expect(
      belongsToPublication(doc(`at://${DID}/site.standard.publication/drafts`), DID, "self"),
    ).toBe(false);
  });

  // Other tools write documents without this convention; don't hide them.
  it("keeps a document with no site at all", () => {
    expect(belongsToPublication(doc(""), DID, "self")).toBe(true);
  });

  it("keeps a document whose publication lives in another repo", () => {
    expect(
      belongsToPublication(doc("at://did:plc:other/site.standard.publication/self"), DID, "self"),
    ).toBe(true);
  });

  it("keeps everything when no publication is pinned", () => {
    expect(belongsToPublication(doc(`at://${DID}/site.standard.publication/drafts`), DID, "")).toBe(
      true,
    );
  });
});

describe("collectDocuments", () => {
  // The ordering contract: publishedAt, not rkey order.
  it("sorts by publishedAt even when rkey order disagrees", () => {
    const records = [
      record(
        valid({ title: "Written last, backdated", publishedAt: "2020-01-01T00:00:00Z" }),
        "3kz",
      ),
      record(valid({ title: "Written first", publishedAt: "2026-01-01T00:00:00Z" }), "3ka"),
    ];
    const docs = collectDocuments("posts", DID, "self", records);
    expect(docs.map((d) => d.title)).toEqual(["Written first", "Written last, backdated"]);
  });

  it("drops unparseable records without failing the batch", () => {
    const records = [
      record(valid({ title: "Good" })),
      record({ title: "No timestamp" }, "3kb"),
      record(valid({ title: "Also good", publishedAt: "2026-02-01T00:00:00Z" }), "3kc"),
    ];
    expect(collectDocuments("posts", DID, "self", records)).toHaveLength(2);
  });

  it("applies the publication filter", () => {
    const records = [
      record(valid({ site: `at://${DID}/site.standard.publication/self` })),
      record(valid({ site: `at://${DID}/site.standard.publication/drafts` }), "3kb"),
    ];
    expect(collectDocuments("posts", DID, "self", records)).toHaveLength(1);
  });

  it("returns an empty list for an empty repo", () => {
    expect(collectDocuments("posts", DID, "self", [])).toEqual([]);
  });
});
