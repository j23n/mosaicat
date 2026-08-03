import { describe, expect, it } from "vitest";
import {
  FrontmatterError,
  parseFrontmatter,
  removeFrontmatterKey,
  setFrontmatterValue,
} from "../src/frontmatter.js";

const FILE = "posts/a-post.md";

const doc = (frontmatter: string, body = "Body text.\n") => `+++\n${frontmatter}+++\n\n${body}`;

describe("parseFrontmatter", () => {
  it("parses every field and normalizes a TOML datetime to a Date", () => {
    const text = doc(
      [
        'title       = "A post"',
        'description = "Summary"',
        'tags        = ["a", "b"]',
        'slug        = "a-post"',
        "published   = 2026-08-03T10:00:00Z",
        'cover       = "./cover.jpg"',
        'source      = "posts"',
        'rkey        = "3kabc"',
        "",
      ].join("\n"),
      "Hello *world*.\n",
    );
    const { frontmatter, body } = parseFrontmatter(FILE, text);

    expect(frontmatter.title).toBe("A post");
    expect(frontmatter.tags).toEqual(["a", "b"]);
    expect(frontmatter.published).toBeInstanceOf(Date);
    expect(frontmatter.published?.toISOString()).toBe("2026-08-03T10:00:00.000Z");
    expect(frontmatter.rkey).toBe("3kabc");
    expect(body).toBe("Hello *world*.\n");
  });

  it("accepts published as a string too", () => {
    const { frontmatter } = parseFrontmatter(
      FILE,
      doc('title = "T"\npublished = "2026-01-02T03:04:05Z"\n'),
    );
    expect(frontmatter.published?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("only requires a title", () => {
    const { frontmatter } = parseFrontmatter(FILE, doc('title = "Just a title"\n'));
    expect(frontmatter.title).toBe("Just a title");
    expect(frontmatter.tags).toBeUndefined();
  });

  // Operator input gets the strict (config) posture, not the record posture.
  it.each([
    ["an unknown key", 'title = "T"\nsurprise = "?"\n'],
    ["a wrongly typed field", 'title = "T"\ntags = "not-a-list"\n'],
    ["a missing title", 'tags = ["a"]\n'],
    ["an empty title", 'title = ""\n'],
    ["an unparseable published string", 'title = "T"\npublished = "not a date"\n'],
  ])("rejects %s with the file path in the message", (_name, frontmatter) => {
    expect(() => parseFrontmatter(FILE, doc(frontmatter))).toThrowError(FrontmatterError);
    expect(() => parseFrontmatter(FILE, doc(frontmatter))).toThrowError(new RegExp(`^${FILE}:`));
  });

  it("rejects a file with no fence at all", () => {
    expect(() => parseFrontmatter(FILE, "Just markdown.\n")).toThrowError(/no \+\+\+ frontmatter/);
  });

  it("rejects an unclosed fence", () => {
    expect(() => parseFrontmatter(FILE, '+++\ntitle = "T"\n')).toThrowError(/never closed/);
  });

  it("rejects invalid TOML", () => {
    expect(() => parseFrontmatter(FILE, "+++\ntitle =\n+++\n")).toThrowError(FrontmatterError);
  });
});

describe("writeback", () => {
  const original = '+++\ntitle  = "A post"   # keep my spacing\n\ntags = ["x"]\n+++\n\nBody.\n';

  it("inserts a new key before the closing fence, byte-for-byte otherwise", () => {
    expect(setFrontmatterValue(original, "rkey", '"3kabc"')).toBe(
      '+++\ntitle  = "A post"   # keep my spacing\n\ntags = ["x"]\nrkey = "3kabc"\n+++\n\nBody.\n',
    );
  });

  it("replaces the line when the key already exists", () => {
    const withRkey = setFrontmatterValue(original, "rkey", '"3kabc"');
    expect(setFrontmatterValue(withRkey, "rkey", '"3knew"')).toBe(
      withRkey.replace('rkey = "3kabc"', 'rkey = "3knew"'),
    );
  });

  it("removes exactly the key's line and nothing else", () => {
    const withRkey = setFrontmatterValue(original, "rkey", '"3kabc"');
    expect(removeFrontmatterKey(withRkey, "rkey")).toBe(original);
  });

  it("leaves the file alone when removing an absent key", () => {
    expect(removeFrontmatterKey(original, "rkey")).toBe(original);
  });

  it("round-trips a published writeback the parser accepts", () => {
    const written = setFrontmatterValue(original, "published", "2026-08-03T12:00:00.000Z");
    const { frontmatter } = parseFrontmatter(FILE, written);
    expect(frontmatter.published?.toISOString()).toBe("2026-08-03T12:00:00.000Z");
  });

  it("never touches a +++ line in the body", () => {
    const tricky = '+++\ntitle = "T"\n+++\n\nCode:\n\n+++\nnot frontmatter\n+++\n';
    const written = setFrontmatterValue(tricky, "rkey", '"3k"');
    expect(written).toBe(
      '+++\ntitle = "T"\nrkey = "3k"\n+++\n\nCode:\n\n+++\nnot frontmatter\n+++\n',
    );
  });
});
