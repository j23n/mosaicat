import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";

const SITE = `
[site]
title = "Test"
base_url = "https://example.com"
`;

const source = (body: string) => `${SITE}\n[[source]]\n${body}\n`;

describe("parseConfig", () => {
  it("applies defaults", () => {
    const config = parseConfig(source(`name = "posts"\nhandle = "a.example.com"`));
    const first = config.source[0]!;

    expect(first.collections).toEqual(["site.standard.document"]);
    // No publication pin by default: other apps' documents claim real rkeys,
    // and a default filter would hide them all.
    expect(first.publication).toBe("");
    expect(first.visibility).toBe("public");
    expect(first.max_records).toBe(1000);
    expect(config.cache_dir).toBe(".atmo/cache");
    expect(config.out_dir).toBe("dist");
  });

  it("keeps an explicit publication pin", () => {
    const config = parseConfig(
      source(`name = "posts"\nhandle = "a.example.com"\npublication = "self"`),
    );
    expect(config.source[0]!.publication).toBe("self");
  });

  it("strips a trailing slash from base_url so joins never double up", () => {
    const config = parseConfig(`
[site]
title = "Test"
base_url = "https://example.com/"

[[source]]
name = "posts"
handle = "a.example.com"
`);
    expect(config.site.base_url).toBe("https://example.com");
  });

  it("accepts an explicit did + pds_url pair", () => {
    const config = parseConfig(
      source(`name = "private"\ndid = "did:plc:abc"\npds_url = "http://pds-private:3000"`),
    );
    expect(config.source[0]!.did).toBe("did:plc:abc");
  });

  // The load-bearing rule: a half-configured identity must fail at load, not
  // at fetch time. Either half alone is rejected.
  it.each([
    ["did only", `name = "private"\ndid = "did:plc:abc"`],
    ["pds_url only", `name = "private"\npds_url = "http://pds-private:3000"`],
  ])("rejects a source with %s", (_label, body) => {
    expect(() => parseConfig(source(body))).toThrow(ConfigError);
  });

  it("rejects duplicate source names", () => {
    const text = `${SITE}
[[source]]
name = "posts"
handle = "a.example.com"

[[source]]
name = "posts"
handle = "b.example.com"
`;
    expect(() => parseConfig(text)).toThrow(/duplicate name/);
  });

  it("rejects a config with no sources", () => {
    expect(() => parseConfig(SITE)).toThrow(ConfigError);
  });

  it("reports the offending path in the message", () => {
    const text = `${SITE}\n[[source]]\nname = "Posts Uppercase"\nhandle = "a.example.com"\n`;
    expect(() => parseConfig(text)).toThrow(/source\.0\.name/);
  });

  it("wraps malformed TOML rather than leaking the parser error type", () => {
    expect(() => parseConfig("[site\ntitle =")).toThrow(ConfigError);
  });
});
