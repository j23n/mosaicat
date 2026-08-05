#!/usr/bin/env node
/**
 * CI helper: init + one-record build through the packed binary.
 * Assumes `npm run build` already produced dist/cache.js and dist-bin/atmo exists.
 */
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { writeSourceCache, CACHE_VERSION } from "../dist/cache.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "dist-bin", "atmo");

try {
  await readFile(bin);
} catch {
  console.error(`pack-smoke: missing binary at ${bin} — run npm run pack first`);
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "atmo-pack-smoke-"));
const init = spawnSync(bin, ["init", "spike.example.com", "--force"], {
  cwd: dir,
  encoding: "utf8",
});
if (init.status !== 0) {
  console.error(init.stderr || init.stdout);
  process.exit(init.status ?? 1);
}

await writeSourceCache(join(dir, ".atmo/cache"), {
  version: CACHE_VERSION,
  source: "posts",
  did: "did:plc:test",
  pdsUrl: "https://pds.example.com",
  fetchedAt: "2026-07-01T00:00:00.000Z",
  collections: {
    "site.standard.document": [
      {
        uri: "at://did:plc:test/site.standard.document/3k1",
        cid: "bafy1",
        rkey: "3k1",
        value: {
          title: "Hello",
          path: "/hello",
          publishedAt: "2026-01-01T00:00:00Z",
          textContent: "Body.",
        },
      },
    ],
  },
  blobs: [],
});

// init writes a handle-based source name; overwrite with the fixture shape.
await writeFile(
  join(dir, "atmo.toml"),
  `[site]
title = "Spike"
base_url = "https://example.com"
description = "spike"

[[source]]
name = "posts"
handle = "you.example.com"
`,
);

const build = spawnSync(bin, ["build", "--force"], { cwd: dir, encoding: "utf8" });
if (build.status !== 0) {
  console.error(build.stderr || build.stdout);
  process.exit(build.status ?? 1);
}
console.log((build.stdout || "").trim());

const files = await readdir(join(dir, "dist"));
if (!files.includes("assets")) {
  console.error("pack-smoke: expected dist/assets", files);
  process.exit(1);
}
const html = await readFile(join(dir, "dist/posts/hello/index.html"), "utf8");
if (!html.includes("Hello")) {
  console.error("pack-smoke: post HTML missing title");
  process.exit(1);
}
console.log("pack-smoke ok");
