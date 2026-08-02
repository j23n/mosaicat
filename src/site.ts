/**
 * The site model: everything `build` needs, derived from the cache alone.
 *
 * No network, no clock, no filesystem beyond reading the cache. Given the same
 * cache this produces the same model, which is what makes the output testable
 * by comparison rather than by inspection.
 */

import type { Config, Source } from "./config.js";
import { rewriteBlobUrls, type BlobRecord } from "./blob.js";
import { collectItems, type CollectionPage } from "./collection.js";
import { readSourceCache } from "./cache.js";
import { DOCUMENT_NSID } from "./config.js";
import { collectDocuments, parseDocument, type Document, type Tag } from "./document.js";
import { excerpt, renderBody } from "./markdown.js";

/** A document plus everything the templates need that isn't in the record. */
export interface Page {
  doc: Document;
  /** Site-absolute path, always with a trailing slash. */
  url: string;
  /** Sanitized HTML body. */
  html: string;
  /** Plain-text summary: the record's own, or derived from the body. */
  summary: string;
}

export interface TagPage {
  tag: Tag;
  url: string;
  pages: Page[];
}

export interface Paginated {
  /** 1-based. */
  number: number;
  url: string;
  pages: Page[];
  previousUrl: string | null;
  nextUrl: string | null;
  totalPages: number;
}

export interface SiteModel {
  config: Config;
  /** Every renderable page, newest first, across all document sources. */
  pages: Page[];
  /** Pages that are public (excludes `visibility = "encrypted"` sources). */
  publicPages: Page[];
  tags: TagPage[];
  index: Paginated[];
  /** Every blob available in the cache, keyed by CID. */
  blobs: BlobRecord[];
  /** Pages for collections other than site.standard.document. */
  collections: CollectionPage[];
  /** Sources that produced no cache entry at all. */
  missingSources: string[];
  /** Records that could not be rendered — the cost of tolerant parsing. */
  skipped: number;
}

export class BuildError extends Error {}

export function pathPrefix(source: Source): string {
  const raw = source.path_prefix ?? `/${source.name}`;
  return `/${raw.split("/").filter(Boolean).join("/")}`;
}

/** Always ends in a slash so relative links inside a page behave. */
export function pageUrl(source: Source, doc: Document): string {
  return `${pathPrefix(source)}/${doc.slug}/`;
}

export function tagUrl(slug: string): string {
  return `/tags/${slug}/`;
}

export function indexUrl(pageNumber: number): string {
  return pageNumber <= 1 ? "/" : `/page/${pageNumber}/`;
}

/** Absolute URL for feeds and canonical links. */
export function absolute(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function paginate(pages: Page[], perPage: number): Paginated[] {
  if (pages.length === 0) {
    return [{ number: 1, url: "/", pages: [], previousUrl: null, nextUrl: null, totalPages: 1 }];
  }
  const totalPages = Math.ceil(pages.length / perPage);
  return Array.from({ length: totalPages }, (_, i) => {
    const number = i + 1;
    return {
      number,
      url: indexUrl(number),
      pages: pages.slice(i * perPage, (i + 1) * perPage),
      previousUrl: number > 1 ? indexUrl(number - 1) : null,
      nextUrl: number < totalPages ? indexUrl(number + 1) : null,
      totalPages,
    };
  });
}

/**
 * Assemble the model from the cache.
 *
 * A source with no cache entry is *recorded*, not fatal — `build` decides what
 * to do about it. Branch `h` turns that list into a refusal to publish.
 */
export async function loadSite(config: Config): Promise<SiteModel> {
  const pages: Page[] = [];
  const missingSources: string[] = [];
  const blobs: BlobRecord[] = [];
  const mimeByCid = new Map<string, string>();
  const collections: CollectionPage[] = [];
  let skipped = 0;

  for (const source of config.source) {
    const cache = await readSourceCache(config.cache_dir, source.name);
    if (cache === null) {
      missingSources.push(source.name);
      continue;
    }

    for (const blob of cache.blobs ?? []) {
      if (!mimeByCid.has(blob.cid)) {
        mimeByCid.set(blob.cid, blob.mimeType);
        blobs.push(blob);
      }
    }

    // Anything that is not a document renders through the NSID registry.
    for (const [nsid, records] of Object.entries(cache.collections)) {
      if (nsid === DOCUMENT_NSID) continue;
      if (source.visibility === "encrypted") continue;
      collections.push({
        source: source.name,
        nsid,
        url: `${pathPrefix(source)}/${nsid}/`,
        items: collectItems(records),
      });
    }

    const records = cache.collections[DOCUMENT_NSID] ?? [];
    const documents = collectDocuments(source.name, cache.did, source.publication, records);
    // Every record that parsed to nothing. Branch `c` drops these silently by
    // design; `doctor` is where that silence is broken.
    skipped += records.filter((r) => parseDocument(source.name, r) === null).length;

    for (const doc of documents) {
      const html = rewriteBlobUrls(renderBody(doc.content, doc.isMarkdown), mimeByCid);
      pages.push({
        doc,
        url: pageUrl(source, doc),
        html,
        summary: doc.summary !== "" ? doc.summary : excerpt(doc.content),
      });
    }
  }

  pages.sort((a, b) => b.doc.publishedAt.getTime() - a.doc.publishedAt.getTime());

  const encrypted = new Set(
    config.source.filter((s) => s.visibility === "encrypted").map((s) => s.name),
  );
  const publicPages = pages.filter((p) => !encrypted.has(p.doc.source));

  // Tags are built from public pages only: a tag page listing a private post's
  // title would leak it, which is exactly what branch `i` is trying to avoid.
  const byTag = new Map<string, TagPage>();
  for (const page of publicPages) {
    for (const tag of page.doc.tags) {
      const existing = byTag.get(tag.slug);
      if (existing) existing.pages.push(page);
      else byTag.set(tag.slug, { tag, url: tagUrl(tag.slug), pages: [page] });
    }
  }
  const tags = [...byTag.values()].sort((a, b) => a.tag.slug.localeCompare(b.tag.slug));

  return {
    config,
    pages,
    publicPages,
    tags,
    index: paginate(publicPages, config.page_size),
    blobs,
    collections,
    missingSources,
    skipped,
  };
}
