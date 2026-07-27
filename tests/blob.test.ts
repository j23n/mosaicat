import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  blobFilename,
  blobUrl,
  cachedBlobs,
  contentCids,
  documentCids,
  extensionFor,
  fetchBlob,
  rewriteBlobUrls,
} from "../src/blob.js";
import type { Document } from "../src/document.js";
import type { Identity } from "../src/identity.js";

const identity: Identity = { did: "did:plc:test", pdsUrl: "https://pds.example", trusted: true };
const CID = "bafkreiabc123";
const blobUrlFor = (cid: string) =>
  `https://pds.example/xrpc/com.atproto.sync.getBlob?did=did:plc:test&cid=${cid}`;

const temp = () => mkdtemp(join(tmpdir(), "atmo-blob-"));

describe("naming", () => {
  it.each([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
    ["image/jpeg; charset=binary", "jpg"],
    ["IMAGE/PNG", "png"],
    ["application/pdf", "bin"],
  ])("%s -> .%s", (mime, ext) => {
    expect(extensionFor(mime)).toBe(ext);
  });

  it("builds a filename and a url from the CID", () => {
    expect(blobFilename(CID, "image/png")).toBe(`${CID}.png`);
    expect(blobUrl(CID, "image/png")).toBe(`/assets/blobs/${CID}.png`);
  });
});

describe("finding CIDs", () => {
  it("extracts them from getBlob urls in a body", () => {
    const body = `![a](${blobUrlFor("bafyone")}) and ![b](${blobUrlFor("bafytwo")})`;
    expect(contentCids(body).sort()).toEqual(["bafyone", "bafytwo"]);
  });

  it("finds none in a body with no blobs", () => {
    expect(contentCids("plain text with a [link](https://example.com)")).toEqual([]);
  });

  it("collects the cover image and body blobs, deduped", () => {
    const doc = {
      cover: { cid: "bafycover", mimeType: "image/png" },
      content: `![x](${blobUrlFor("bafybody")}) ![again](${blobUrlFor("bafycover")})`,
    } as Document;
    expect(documentCids(doc).sort()).toEqual(["bafybody", "bafycover"]);
  });
});

describe("rewriteBlobUrls", () => {
  const mimes = new Map([[CID, "image/png"]]);

  it("points a getBlob src at the local asset", () => {
    const html = `<img src="${blobUrlFor(CID)}" alt="x" />`;
    expect(rewriteBlobUrls(html, mimes)).toContain(`src="/assets/blobs/${CID}.png"`);
  });

  // A CID we never downloaded must keep working against the PDS.
  it("leaves an unknown CID untouched", () => {
    const html = `<img src="${blobUrlFor("bafyunknown")}" />`;
    expect(rewriteBlobUrls(html, mimes)).toBe(html);
  });

  it("leaves ordinary urls alone", () => {
    const html = '<img src="https://example.com/cat.png" />';
    expect(rewriteBlobUrls(html, mimes)).toBe(html);
  });
});

describe("fetchBlob", () => {
  const respond = (body: string, type = "image/png") =>
    vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": type } }));

  it("downloads and stores under the CID", async () => {
    const dir = await temp();
    const fetcher = respond("PNGDATA");
    const blob = await fetchBlob(dir, identity, CID, new Set(), { fetcher: fetcher as never });

    expect(blob).toMatchObject({ cid: CID, mimeType: "image/png" });
    expect(await readdir(join(dir, "blobs"))).toEqual([`${CID}.png`]);
    expect(await readFile(join(dir, "blobs", `${CID}.png`), "utf8")).toBe("PNGDATA");
  });

  // The point of content addressing: the bytes for a CID never change.
  it("does not refetch a CID already in the cache", async () => {
    const dir = await temp();
    await mkdir(join(dir, "blobs"), { recursive: true });
    await writeFile(join(dir, "blobs", `${CID}.png`), "OLD");

    const fetcher = respond("NEW");
    const existing = await cachedBlobs(dir);
    const blob = await fetchBlob(dir, identity, CID, existing, { fetcher: fetcher as never });

    expect(fetcher).not.toHaveBeenCalled();
    expect(blob?.mimeType).toBe("image/png");
    expect(await readFile(join(dir, "blobs", `${CID}.png`), "utf8")).toBe("OLD");
  });

  it("returns null on a failed fetch rather than throwing", async () => {
    const dir = await temp();
    const fetcher = vi.fn(async () => new Response("", { status: 404 }));
    await expect(
      fetchBlob(dir, identity, CID, new Set(), { fetcher: fetcher as never }),
    ).resolves.toBeNull();
  });

  it("returns null when the request errors", async () => {
    const dir = await temp();
    const fetcher = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      fetchBlob(dir, identity, CID, new Set(), { fetcher: fetcher as never }),
    ).resolves.toBeNull();
  });

  it("checks the address for an untrusted identity", async () => {
    const dir = await temp();
    const untrusted: Identity = { ...identity, trusted: false };
    const fetcher = respond("X");
    const blob = await fetchBlob(dir, untrusted, CID, new Set(), {
      fetcher: fetcher as never,
      dnsLookup: async () => ["10.0.0.1"],
    });
    expect(blob).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("skips the check for a trusted (configured) identity", async () => {
    const dir = await temp();
    const fetcher = respond("X");
    const blob = await fetchBlob(dir, identity, CID, new Set(), {
      fetcher: fetcher as never,
      dnsLookup: async () => ["10.0.0.1"],
    });
    expect(blob).not.toBeNull();
  });

  it("reads an empty set for a cache directory that does not exist", async () => {
    await expect(cachedBlobs(join(await temp(), "nope"))).resolves.toEqual(new Set());
  });
});
