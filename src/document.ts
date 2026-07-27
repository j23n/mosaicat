/**
 * Turning records into something a template can render.
 *
 * A repo is not a database. Anyone — you, another app, a buggy client, a
 * deliberate troll — can write a `site.standard.document` into it, and nothing
 * validates it on the way in. So every field here is treated as untrusted:
 * wrong types are ignored, missing essentials skip the record, and **no record
 * shape can throw**. A malformed record costs you that one post, never the
 * build.
 */

import type { RawRecord } from "./repo.js";

/** A tag, with the slug the URL will use. */
export interface Tag {
  name: string;
  slug: string;
}

/** One document, shaped for templates. */
export interface Document {
  /** Which configured source this came from. */
  source: string;
  rkey: string;
  uri: string;
  cid: string;
  /** URL-safe identifier derived from `path`, falling back to the rkey. */
  slug: string;
  title: string;
  summary: string;
  /** Markdown when the record carries it, else plain text. */
  content: string;
  /** True when `content` is markdown rather than pre-flattened text. */
  isMarkdown: boolean;
  tags: Tag[];
  publishedAt: Date;
  updatedAt: Date;
  /** AT-URI of the publication this document claims, or "". */
  site: string;
  /** Blob ref for the cover image, if the record has a usable one. */
  cover: BlobRef | null;
}

/** A blob reference as it appears inside a record. */
export interface BlobRef {
  cid: string;
  mimeType: string;
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Parse a date, returning null for anything unusable. */
function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Extract a blob ref, tolerating both the modern and legacy shapes. */
export function asBlobRef(value: unknown): BlobRef | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const ref = record["ref"];
  const cid =
    typeof ref === "object" && ref !== null
      ? asString((ref as Record<string, unknown>)["$link"])
      : asString(ref);
  if (cid === "") return null;
  return { cid, mimeType: asString(record["mimeType"]) || "application/octet-stream" };
}

/**
 * Pull markdown out of a document's `content` block.
 *
 * `content` is an open union — a lexicon can carry any shape there, including
 * one that didn't exist when this was written. Probe for the fields we
 * understand and give up quietly otherwise; `textContent` is always the
 * fallback.
 */
export function contentMarkdown(value: Record<string, unknown>): string {
  const content = value["content"];
  if (typeof content === "string") return content;
  if (typeof content !== "object" || content === null) return "";

  const block = content as Record<string, unknown>;
  for (const key of ["markdown", "text", "value", "source"]) {
    const candidate = block[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return "";
}

/** Derive a slug from the record's `path`, falling back to the rkey. */
export function slugFrom(path: unknown, rkey: string): string {
  const raw = asString(path);
  if (raw !== "") {
    const last = raw.split("/").filter(Boolean).pop();
    if (last !== undefined) {
      const slug = slugify(last);
      if (slug !== "") return slug;
    }
  }
  return slugify(rkey) || rkey;
}

/**
 * Shape one record, or null when it cannot be rendered.
 *
 * Only two things are actually required: an rkey (the record's address) and a
 * parseable `publishedAt` (the ordering key and part of every URL). Everything
 * else degrades to a default.
 */
export function parseDocument(source: string, record: RawRecord): Document | null {
  if (record.rkey === "") return null;

  const value = record.value;
  const publishedAt = asDate(value["publishedAt"]);
  if (publishedAt === null) return null;

  const markdown = contentMarkdown(value);
  const text = asString(value["textContent"]);

  const rawTags = Array.isArray(value["tags"]) ? value["tags"] : [];
  const tags: Tag[] = [];
  const seenTags = new Set<string>();
  for (const entry of rawTags) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    const slug = slugify(name);
    if (name === "" || slug === "" || seenTags.has(slug)) continue;
    seenTags.add(slug);
    tags.push({ name, slug });
  }

  return {
    source,
    rkey: record.rkey,
    uri: record.uri,
    cid: record.cid,
    slug: slugFrom(value["path"], record.rkey),
    title: asString(value["title"]),
    summary: asString(value["description"]),
    content: markdown !== "" ? markdown : text,
    isMarkdown: markdown !== "",
    tags,
    publishedAt,
    updatedAt: asDate(value["updatedAt"]) ?? publishedAt,
    site: asString(value["site"]),
    cover: asBlobRef(value["coverImage"]),
  };
}

/**
 * Whether a document belongs to the publication a source pinned.
 *
 * Documents name their publication in `site`. A source pins one rkey, and a
 * record positively claiming a *different* publication **in the same repo** is
 * excluded — that is how drafts and posts share one repo without leaking into
 * each other's listings.
 *
 * A record with no parseable `site`, or one pointing at another repo entirely,
 * is kept. Other tools write documents without this convention, and hiding a
 * user's own content because it lacks a field we invented would be wrong.
 */
export function belongsToPublication(doc: Document, did: string, publicationRkey: string): boolean {
  if (publicationRkey === "" || doc.site === "") return true;
  const prefix = `at://${did}/site.standard.publication/`;
  if (!doc.site.startsWith(prefix)) return true;
  return doc.site.slice(prefix.length) === publicationRkey;
}

/**
 * Every renderable document from one source's records, newest first.
 *
 * Ordering comes from `publishedAt`, a value *inside* the record — not from
 * rkey order. TIDs encode creation time, and creation time diverges from
 * publication time the moment anyone backdates a post, imports an archive, or
 * publishes a draft written last month. The wire order decides which records
 * survive the fetch cap; this decides what the reader sees.
 */
export function collectDocuments(
  source: string,
  did: string,
  publicationRkey: string,
  records: RawRecord[],
): Document[] {
  const documents: Document[] = [];
  for (const record of records) {
    const doc = parseDocument(source, record);
    if (doc === null) continue;
    if (!belongsToPublication(doc, did, publicationRkey)) continue;
    documents.push(doc);
  }
  documents.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  return documents;
}
