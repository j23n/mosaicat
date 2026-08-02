/**
 * Collections you did not design.
 *
 * Your repo holds more than your writing. Tangled writes `sh.tangled.repo`
 * when you create a repository; BookHive writes `buzz.bookhive.book` when you
 * shelve a book. Those records are yours, sitting in your PDS, addressable —
 * and nothing stops your own site from rendering them.
 *
 * This is the **personal AppView** pattern. Bluesky's AppView indexes the
 * whole network's firehose; yours indexes exactly one repo, at build time,
 * with an unauthenticated read. No index, no database, no firehose.
 *
 * The NSID is the only contract. `atmo` renders a collection it has a template
 * for, and falls back to a generic renderer for one it has never seen — so a
 * lexicon invented tomorrow produces a page today.
 */

import type { RawRecord } from "./repo.js";

/** One record of an arbitrary collection, prepared for a template. */
export interface CollectionItem {
  rkey: string;
  uri: string;
  cid: string;
  /** The raw record body. Templates for a known NSID read named fields. */
  value: Record<string, unknown>;
  /** Best-effort display title, for the generic renderer. */
  label: string;
  /** Best-effort timestamp, used only for ordering when one exists. */
  at: Date | null;
  /** Flattened `key: value` rows, for the generic renderer. */
  fields: { key: string; value: string }[];
}

export interface CollectionPage {
  source: string;
  /** The collection's NSID — also the template name to look for. */
  nsid: string;
  url: string;
  items: CollectionItem[];
}

/** Field names worth trying for a human-readable label, in order. */
const LABEL_KEYS = ["name", "title", "displayName", "subject", "text", "description"];

/** Field names that usually carry a timestamp. */
const DATE_KEYS = ["createdAt", "publishedAt", "indexedAt", "updatedAt", "startedAt", "finishedAt"];

function firstString(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return "";
}

function firstDate(value: Record<string, unknown>, keys: string[]): Date | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate !== "string") continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** Render a value as a short string for the generic table. */
function flatten(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (depth > 1) return `[${value.length} items]`;
    return value
      .map((entry) => flatten(entry, depth + 1))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "object") {
    if (depth > 1) return "{…}";
    const record = value as Record<string, unknown>;
    const label = firstString(record, LABEL_KEYS);
    if (label !== "") return label;
    const link = record["$link"];
    if (typeof link === "string") return link;
    return Object.keys(record).join(", ");
  }
  return "";
}

/**
 * Shape one arbitrary record.
 *
 * Same posture as branch `c`: nothing here can throw, and a record whose
 * shape is entirely unfamiliar still produces something renderable.
 */
export function parseItem(record: RawRecord): CollectionItem {
  const value = record.value;
  const fields = Object.entries(value)
    .filter(([key]) => key !== "$type")
    .map(([key, raw]) => ({ key, value: flatten(raw) }))
    .filter((field) => field.value !== "");

  return {
    rkey: record.rkey,
    uri: record.uri,
    cid: record.cid,
    value,
    label: firstString(value, LABEL_KEYS) || record.rkey,
    at: firstDate(value, DATE_KEYS),
    fields,
  };
}

/**
 * Build a page for one collection, newest first where a date is available.
 *
 * Records with no recognisable timestamp keep their wire order (rkey
 * descending), which for TIDs is close enough to newest-first and is the only
 * ordering information available.
 */
export function collectItems(records: RawRecord[]): CollectionItem[] {
  const items = records.map(parseItem);
  const dated = items.filter((item) => item.at !== null);
  const undated = items.filter((item) => item.at === null);
  dated.sort((a, b) => b.at!.getTime() - a.at!.getTime());
  return [...dated, ...undated];
}

/** Template names to try for a collection, most specific first. */
export function templateCandidates(nsid: string): string[] {
  return [`collections/${nsid}.eta`, "collections/default.eta"];
}

/** A readable heading for a collection nobody wrote a template for. */
export function collectionHeading(nsid: string): string {
  const last = nsid.split(".").pop() ?? nsid;
  return last.charAt(0).toUpperCase() + last.slice(1);
}
