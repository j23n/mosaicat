import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/build.js";
import { writeSourceCache, CACHE_VERSION } from "../src/cache.js";
import { parseConfig, type Config } from "../src/config.js";
import {
  base32,
  createSiteKeys,
  decryptWith,
  derivePath,
  encryptTo,
  PATH_LENGTH,
  postLabel,
  siteKeysFrom,
  unwrapIdentity,
} from "../src/crypto.js";
import { loadSiteKeys, passphraseFromEnv } from "../src/private.js";
import type { RawRecord } from "../src/repo.js";

const PASS = "correct horse battery staple";
const DID = "did:plc:test";

const doc = (n: number, extra: Record<string, unknown> = {}): RawRecord => ({
  uri: `at://${DID}/site.standard.document/3k${n}`,
  cid: `bafy${n}`,
  rkey: `3k${n}`,
  value: {
    title: `Secret ${n}`,
    path: `/s${n}`,
    publishedAt: `2026-01-0${n}T00:00:00Z`,
    textContent: `Confidential body ${n}.`,
    ...extra,
  },
});

async function project(privateDocs: RawRecord[], publicDocs: RawRecord[] = []): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "atmo-priv-"));
  const config = {
    ...parseConfig(`
[site]
title = "T"
base_url = "https://example.com"

[private]
identity_file = "${join(dir, "identity").replace(/\\/g, "/")}"

[[source]]
name = "posts"
handle = "you.example.com"

[[source]]
name = "vault"
did = "did:plc:vault"
pds_url = "http://pds-private:3000"
visibility = "encrypted"
`),
    cache_dir: join(dir, "cache"),
    out_dir: join(dir, "out"),
  };
  for (const [name, did, records] of [
    ["posts", DID, publicDocs],
    ["vault", "did:plc:vault", privateDocs],
  ] as const) {
    await writeSourceCache(config.cache_dir, {
      version: CACHE_VERSION,
      source: name,
      did,
      pdsUrl: "https://pds.example",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      collections: { "site.standard.document": records as RawRecord[] },
      blobs: [],
    });
  }
  return config;
}

describe("crypto primitives", () => {
  it("round-trips a payload through the site identity", async () => {
    const keys = await createSiteKeys(PASS);
    const ct = await encryptTo(keys.recipient, "hello");
    await expect(decryptWith(keys.identity, ct)).resolves.toBe("hello");
  });

  it("unwraps the identity with the right passphrase and not the wrong one", async () => {
    const keys = await createSiteKeys(PASS);
    await expect(unwrapIdentity(keys.wrapped, PASS)).resolves.toBe(keys.identity);
    await expect(unwrapIdentity(keys.wrapped, "wrong")).resolves.toBeNull();
  });

  it("produces stable, unguessable paths of a fixed length", async () => {
    const keys = await createSiteKeys(PASS);
    const a = await derivePath(keys.identity, postLabel("3ka"));
    const b = await derivePath(keys.identity, postLabel("3ka"));
    const c = await derivePath(keys.identity, postLabel("3kb"));

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(PATH_LENGTH);
    expect(a).toMatch(/^[a-z2-7]+$/);
  });

  // Different identity => different paths. This is why the identity persists.
  it("gives different paths under a different identity", async () => {
    const one = await createSiteKeys(PASS);
    const two = await createSiteKeys(PASS);
    expect(await derivePath(one.identity, "index")).not.toBe(
      await derivePath(two.identity, "index"),
    );
  });

  it("re-wraps an existing identity rather than minting one", async () => {
    const keys = await createSiteKeys(PASS);
    const again = await siteKeysFrom(keys.identity, PASS);
    expect(again.identity).toBe(keys.identity);
    expect(await derivePath(again.identity, "index")).toBe(
      await derivePath(keys.identity, "index"),
    );
  });

  it("encodes base32 without padding", () => {
    expect(base32(new Uint8Array([0, 0, 0, 0, 0]))).toBe("aaaaaaaa");
    expect(base32(new Uint8Array([255]))).toMatch(/^[a-z2-7]+$/);
  });
});

describe("passphrase handling", () => {
  it("reads it from the environment only", () => {
    expect(passphraseFromEnv({ ATMO_PASSPHRASE: "x" })).toBe("x");
    expect(passphraseFromEnv({})).toBeNull();
    expect(passphraseFromEnv({ ATMO_PASSPHRASE: "   " })).toBeNull();
  });

  it("persists the identity so paths survive a rebuild", async () => {
    const config = await project([doc(1)]);
    const first = await loadSiteKeys(config, PASS);
    const second = await loadSiteKeys(config, PASS);
    expect(second.identity).toBe(first.identity);
  });
});

describe("private build", () => {
  const withPass = async <T>(fn: () => Promise<T>): Promise<T> => {
    process.env["ATMO_PASSPHRASE"] = PASS;
    try {
      return await fn();
    } finally {
      delete process.env["ATMO_PASSPHRASE"];
    }
  };

  it("refuses to build private pages without a passphrase", async () => {
    const config = await project([doc(1)], [doc(2)]);
    delete process.env["ATMO_PASSPHRASE"];
    await expect(build(config)).rejects.toThrow(/ATMO_PASSPHRASE/);
  });

  it("emits an entry page, a manifest and one payload per post", async () => {
    const config = await project([doc(1), doc(2)], [doc(3)]);
    const { written } = await withPass(() => build(config));

    expect(written).toContain("/private/index.html");
    expect(written).toContain("/assets/decrypt.js");
    expect(written.filter((p) => p.endsWith("payload.age"))).toHaveLength(3); // 2 posts + manifest
  });

  // The core property: nothing readable escapes.
  it("writes no plaintext of a private post anywhere in the output", async () => {
    const config = await project([doc(1)], [doc(3)]);
    await withPass(() => build(config));

    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(config.out_dir);

    for (const file of files) {
      const text = await readFile(file, "utf8").catch(() => "");
      expect(text).not.toContain("Confidential body 1.");
      expect(text).not.toContain("Secret 1");
    }
  });

  it("keeps the private post out of the feed, sitemap and index", async () => {
    const config = await project([doc(1)], [doc(3)]);
    await withPass(() => build(config));

    for (const path of ["feed.xml", "sitemap.xml", "index.html"]) {
      const text = await readFile(join(config.out_dir, path), "utf8");
      expect(text).not.toContain("Secret 1");
      expect(text).not.toContain("/p/");
    }
  });

  it("gives the entry page no post URLs at all", async () => {
    const config = await project([doc(1), doc(2)], [doc(3)]);
    await withPass(() => build(config));
    const html = await readFile(join(config.out_dir, "private", "index.html"), "utf8");

    expect(html).not.toContain("/p/");
    expect(html).toContain("data-atmo-private");
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).toContain('name="referrer" content="no-referrer"');
  });

  it("makes the payload decryptable with the identity and not without", async () => {
    const config = await project([doc(1)], [doc(3)]);
    await withPass(() => build(config));

    const keys = await loadSiteKeys(config, PASS);
    const path = await derivePath(keys.identity, postLabel("3k1"));
    const bytes = new Uint8Array(await readFile(join(config.out_dir, "p", path, "payload.age")));

    const html = await decryptWith(keys.identity, bytes);
    expect(html).toContain("Confidential body 1.");

    const other = await createSiteKeys(PASS);
    await expect(decryptWith(other.identity, bytes)).rejects.toThrow();
  });

  it("ships an identical shell for every private post", async () => {
    const config = await project([doc(1), doc(2)], [doc(3)]);
    await withPass(() => build(config));

    const keys = await loadSiteKeys(config, PASS);
    const a = await readFile(
      join(config.out_dir, "p", await derivePath(keys.identity, postLabel("3k1")), "index.html"),
      "utf8",
    );
    const b = await readFile(
      join(config.out_dir, "p", await derivePath(keys.identity, postLabel("3k2")), "index.html"),
      "utf8",
    );
    expect(a).toBe(b);
  });

  it("never writes the secret identity into the output", async () => {
    const config = await project([doc(1)], [doc(3)]);
    await withPass(() => build(config));
    const keys = await loadSiteKeys(config, PASS);

    const entry = await readFile(join(config.out_dir, "private", "index.html"), "utf8");
    expect(entry).not.toContain(keys.identity);
  });
});
