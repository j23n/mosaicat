import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { FrontmatterError } from "../src/frontmatter.js";
import { publish, unpublish } from "../src/publish.js";
import { AuthError } from "../src/write.js";
import { fakeBlobCid, fakeNetwork, type FakeRepo } from "./fake-pds.js";

const DID = "did:plc:testtesttesttesttesttest";
const PDS = "https://pds.example.com";
const PASSWORD = "app-pass-xxxx";

const repo = (): FakeRepo => ({
  did: DID,
  handle: "you.example.com",
  pdsUrl: PDS,
  collections: {},
  password: PASSWORD,
});

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

const ENV = { ATMO_APP_PASSWORD: PASSWORD };
const NOW = () => new Date("2026-08-03T12:00:00.000Z");

const temp = () => mkdtemp(join(tmpdir(), "atmo-publish-"));

async function post(dir: string, name: string, frontmatter: string, body = "Hello world.\n") {
  const path = join(dir, name);
  await writeFile(path, `+++\n${frontmatter}+++\n\n${body}`);
  return path;
}

describe("publish", () => {
  it("creates a record and writes rkey and published back into the file", async () => {
    const dir = await temp();
    const file = await post(dir, "first.md", 'title = "First"\ntags = ["a"]\n');
    const net = fakeNetwork([repo()]);

    const results = await publish(configFor(), [file], { ...net, env: ENV, now: NOW });

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("created");
    expect(results[0]!.uri).toMatch(new RegExp(`^at://${DID}/site.standard.document/`));

    const record = net.records.get(results[0]!.uri)!;
    expect(record).toMatchObject({
      $type: "site.standard.document",
      title: "First",
      path: "/first",
      tags: ["a"],
      content: "Hello world.\n",
      textContent: "Hello world.",
      publishedAt: "2026-08-03T12:00:00.000Z",
    });
    expect(record["updatedAt"]).toBeUndefined();
    expect(record["description"]).toBeUndefined();
    expect(record["site"]).toBeUndefined();
    expect(record["coverImage"]).toBeUndefined();

    const written = await readFile(file, "utf8");
    const rkey = results[0]!.uri.split("/").pop()!;
    expect(written).toContain(`rkey = "${rkey}"`);
    expect(written).toContain("published = 2026-08-03T12:00:00.000Z");
    expect(written.endsWith("Hello world.\n")).toBe(true);
  });

  it("republishes via putRecord, preserving publishedAt and setting updatedAt", async () => {
    const dir = await temp();
    const file = await post(
      dir,
      "again.md",
      'title = "Again"\npublished = 2026-01-01T00:00:00Z\nrkey = "3kexisting"\n',
    );
    const net = fakeNetwork([repo()]);

    const results = await publish(configFor(), [file], { ...net, env: ENV, now: NOW });

    expect(results[0]!.action).toBe("updated");
    expect(results[0]!.uri).toBe(`at://${DID}/site.standard.document/3kexisting`);
    expect(net.calls.some((u) => u.includes("putRecord"))).toBe(true);
    expect(net.calls.some((u) => u.includes("createRecord"))).toBe(false);

    const record = net.records.get(results[0]!.uri)!;
    expect(record["publishedAt"]).toBe("2026-01-01T00:00:00.000Z");
    expect(record["updatedAt"]).toBe("2026-08-03T12:00:00.000Z");

    // The frontmatter already had both keys; the file is untouched.
    expect(await readFile(file, "utf8")).toContain('rkey = "3kexisting"');
  });

  it("uploads relative images and rewrites their URLs to atproto://getBlob", async () => {
    const dir = await temp();
    await mkdir(join(dir, "img"));
    await writeFile(join(dir, "img", "pic.png"), Buffer.from("png-bytes"));
    const file = await post(dir, "pics.md", 'title = "Pics"\n', "Look:\n\n![alt](img/pic.png)\n");
    const net = fakeNetwork([repo()]);

    const results = await publish(configFor(), [file], { ...net, env: ENV, now: NOW });

    const cid = fakeBlobCid(Buffer.from("png-bytes"));
    expect(net.blobs.has(cid)).toBe(true);
    const record = net.records.get(results[0]!.uri)!;
    expect(record["content"]).toContain(`![alt](atproto://getBlob?cid=${cid})`);
    expect(record["content"]).not.toContain("img/pic.png");
    // Stripped text drops the image entirely.
    expect(record["textContent"]).toBe("Look:");
  });

  it("leaves http and atproto image URLs untouched", async () => {
    const dir = await temp();
    const file = await post(
      dir,
      "remote.md",
      'title = "Remote"\n',
      "![a](https://cdn.example.com/x.png)\n\n![b](atproto://getBlob?cid=bafyold)\n",
    );
    const net = fakeNetwork([repo()]);

    const results = await publish(configFor(), [file], { ...net, env: ENV, now: NOW });

    expect(net.blobs.size).toBe(0);
    const record = net.records.get(results[0]!.uri)!;
    expect(record["content"]).toContain("https://cdn.example.com/x.png");
    expect(record["content"]).toContain("atproto://getBlob?cid=bafyold");
  });

  it("uploads the cover and embeds its blob ref as coverImage", async () => {
    const dir = await temp();
    await writeFile(join(dir, "cover.jpg"), Buffer.from("jpg-bytes"));
    const file = await post(dir, "covered.md", 'title = "Covered"\ncover = "./cover.jpg"\n');
    const net = fakeNetwork([repo()]);

    const results = await publish(configFor(), [file], { ...net, env: ENV, now: NOW });

    const cid = fakeBlobCid(Buffer.from("jpg-bytes"));
    const record = net.records.get(results[0]!.uri)!;
    expect(record["coverImage"]).toEqual({
      $type: "blob",
      ref: { $link: cid },
      mimeType: "image/jpeg",
      size: 9,
    });
  });

  it("refuses before any network call when an image is missing", async () => {
    const dir = await temp();
    const file = await post(dir, "broken.md", 'title = "Broken"\n', "![gone](./gone.png)\n");
    const net = fakeNetwork([repo()]);

    await expect(publish(configFor(), [file], { ...net, env: ENV })).rejects.toThrowError(
      FrontmatterError,
    );
    expect(net.calls).toHaveLength(0);
  });

  it("sets site when the source pins a publication", async () => {
    const dir = await temp();
    const file = await post(dir, "pinned.md", 'title = "Pinned"\n');
    const net = fakeNetwork([repo()]);

    const results = await publish(configFor('publication = "self"'), [file], {
      ...net,
      env: ENV,
      now: NOW,
    });

    expect(net.records.get(results[0]!.uri)!["site"]).toBe(
      `at://${DID}/site.standard.publication/self`,
    );
  });

  it("requires --source when the config has more than one source", async () => {
    const dir = await temp();
    const file = await post(dir, "which.md", 'title = "Which"\n');
    const net = fakeNetwork([repo()]);
    const config = parseConfig(`
[site]
title = "Test"
base_url = "https://example.com"

[[source]]
name = "posts"
handle = "you.example.com"

[[source]]
name = "notes"
handle = "notes.example.com"
`);

    await expect(publish(config, [file], { ...net, env: ENV })).rejects.toThrowError(ConfigError);
    await expect(publish(config, [file], { ...net, env: ENV })).rejects.toThrow(/--source/);
    expect(net.calls).toHaveLength(0);

    // Naming one of them works; naming a stranger is a config error.
    await expect(
      publish(config, [file], { ...net, env: ENV, now: NOW, sourceName: "posts" }),
    ).resolves.toHaveLength(1);
    await expect(
      publish(config, [file], { ...net, env: ENV, sourceName: "nope" }),
    ).rejects.toThrowError(ConfigError);
  });

  it("refuses a file pinned to a different source", async () => {
    const dir = await temp();
    const file = await post(dir, "pin.md", 'title = "Pin"\nsource = "other"\n');
    const net = fakeNetwork([repo()]);

    await expect(publish(configFor(), [file], { ...net, env: ENV })).rejects.toThrow(
      /pinned to source "other"/,
    );
    expect(net.calls).toHaveLength(0);
  });

  it("fails with AuthError when no app password is in the env", async () => {
    const dir = await temp();
    const file = await post(dir, "nopass.md", 'title = "No pass"\n');
    const net = fakeNetwork([repo()]);

    await expect(publish(configFor(), [file], { ...net, env: {} })).rejects.toThrowError(AuthError);
  });

  it("fails with AuthError when the PDS rejects the password", async () => {
    const dir = await temp();
    const file = await post(dir, "badpass.md", 'title = "Bad pass"\n');
    const net = fakeNetwork([repo()]);

    await expect(
      publish(configFor(), [file], { ...net, env: { ATMO_APP_PASSWORD: "wrong" } }),
    ).rejects.toThrowError(AuthError);
  });

  it("prefers the per-source env var over the generic one", async () => {
    const dir = await temp();
    const file = await post(dir, "pref.md", 'title = "Pref"\n');
    const net = fakeNetwork([repo()]);

    const results = await publish(configFor(), [file], {
      ...net,
      now: NOW,
      env: { ATMO_APP_PASSWORD: "wrong", ATMO_APP_PASSWORD_POSTS: PASSWORD },
    });
    expect(results[0]!.action).toBe("created");
  });

  it("publishes plaintext to a private did+pds_url source, no SSRF check", async () => {
    const dir = await temp();
    const file = await post(dir, "private.md", 'title = "Private"\n', "Secret body.\n");
    const net = fakeNetwork([
      {
        did: "did:plc:private",
        pdsUrl: "http://pds-private:3000",
        collections: {},
        password: PASSWORD,
      },
    ]);
    const config = parseConfig(`
[site]
title = "Test"
base_url = "https://example.com"

[[source]]
name = "private"
did = "did:plc:private"
pds_url = "http://pds-private:3000"
visibility = "encrypted"
`);

    const results = await publish(config, [file], {
      ...net,
      env: ENV,
      now: NOW,
      // The endpoint is operator-configured, so a private address is fine.
      dnsLookup: async () => ["10.0.0.1"],
    });

    expect(results[0]!.uri).toBe(
      `at://did:plc:private/site.standard.document/${results[0]!.uri.split("/").pop()}`,
    );
    expect(net.calls.every((u) => u.startsWith("http://pds-private:3000/"))).toBe(true);
    // Plaintext on the wire: encryption is a build concern, not a publish one.
    expect(net.records.get(results[0]!.uri)!["content"]).toBe("Secret body.\n");
  });

  it("dry-run plans without a single network call or file change", async () => {
    const dir = await temp();
    const file = await post(dir, "plan.md", 'title = "Plan"\n');
    const before = await readFile(file, "utf8");
    const net = fakeNetwork([repo()]);
    const lines: string[] = [];

    const results = await publish(configFor(), [file], {
      ...net,
      env: {}, // not even a password is needed for a dry run
      dryRun: true,
      log: (l) => lines.push(l),
    });

    expect(results).toEqual([{ path: file, uri: "", action: "would create" }]);
    expect(net.calls).toHaveLength(0);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(lines.join("\n")).toContain("would create");
  });

  it("validates the whole batch before any network call", async () => {
    const dir = await temp();
    const good = await post(dir, "good.md", 'title = "Good"\n');
    const bad = await post(dir, "bad.md", 'tags = ["no title"]\n');
    const net = fakeNetwork([repo()]);

    await expect(publish(configFor(), [good, bad], { ...net, env: ENV })).rejects.toThrowError(
      FrontmatterError,
    );
    expect(net.calls).toHaveLength(0);
    expect(net.records.size).toBe(0);
    // The good file was not half-published: no writeback happened.
    expect(await readFile(good, "utf8")).not.toContain("rkey");
  });
});

describe("unpublish", () => {
  it("deletes the record and strips the rkey line from the file", async () => {
    const dir = await temp();
    const file = await post(
      dir,
      "gone.md",
      'title = "Gone"\npublished = 2026-01-01T00:00:00Z\nrkey = "3kgone"\n',
    );
    const net = fakeNetwork([repo()]);

    const results = await unpublish(configFor(), [file], { ...net, env: ENV });

    const uri = `at://${DID}/site.standard.document/3kgone`;
    expect(results).toEqual([{ path: file, uri, action: "deleted" }]);
    expect(net.deleted).toEqual([uri]);

    const written = await readFile(file, "utf8");
    expect(written).not.toContain("rkey");
    // Everything else survives: title, published, body.
    expect(written).toContain('title = "Gone"');
    expect(written).toContain("published = 2026-01-01T00:00:00Z");
    expect(written).toContain("Hello world.");
  });

  it("refuses a file without an rkey", async () => {
    const dir = await temp();
    const file = await post(dir, "never.md", 'title = "Never published"\n');
    const net = fakeNetwork([repo()]);

    await expect(unpublish(configFor(), [file], { ...net, env: ENV })).rejects.toThrow(/no rkey/);
    expect(net.calls).toHaveLength(0);
  });

  it("dry-run prints the exact AT-URIs and deletes nothing", async () => {
    const dir = await temp();
    const file = await post(dir, "still.md", 'title = "Still here"\nrkey = "3kstill"\n');
    const net = fakeNetwork([repo()]);
    const lines: string[] = [];

    const results = await unpublish(configFor(), [file], {
      ...net,
      env: {},
      dryRun: true,
      log: (l) => lines.push(l),
    });

    const uri = `at://${DID}/site.standard.document/3kstill`;
    expect(results).toEqual([{ path: file, uri, action: "would delete" }]);
    expect(lines.join("\n")).toContain(uri);
    expect(net.deleted).toHaveLength(0);
    // Identity resolution may run (it is unauthenticated); no write endpoints did.
    expect(net.calls.every((u) => !u.includes("deleteRecord") && !u.includes("Session"))).toBe(
      true,
    );
    expect(await readFile(file, "utf8")).toContain('rkey = "3kstill"');
  });
});

describe("cli exit codes", () => {
  async function projectWithConfig() {
    const dir = await temp();
    const configPath = join(dir, "atmo.toml");
    await writeFile(
      configPath,
      '[site]\ntitle = "T"\nbase_url = "https://example.com"\n\n[[source]]\nname = "posts"\nhandle = "you.example.com"\n',
    );
    return { dir, configPath };
  }

  it("returns 1 when publish is given no files", async () => {
    const { configPath } = await projectWithConfig();
    expect(await main(["publish", "--config", configPath])).toBe(1);
  });

  it("returns 2 for a frontmatter failure", async () => {
    const { dir, configPath } = await projectWithConfig();
    const file = join(dir, "nofence.md");
    await writeFile(file, "no fence here\n");
    expect(await main(["publish", file, "--config", configPath])).toBe(2);
  });

  it("returns 2 for an unknown --source", async () => {
    const { dir, configPath } = await projectWithConfig();
    const file = await post(dir, "x.md", 'title = "X"\n');
    expect(await main(["publish", file, "--source", "nope", "--config", configPath])).toBe(2);
  });

  it("returns 2 when unpublishing a file that was never published", async () => {
    const { dir, configPath } = await projectWithConfig();
    const file = await post(dir, "y.md", 'title = "Y"\n');
    expect(await main(["unpublish", file, "--config", configPath])).toBe(2);
  });
});
