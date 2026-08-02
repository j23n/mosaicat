/**
 * Rendering Leaflet documents.
 *
 * `site.standard.document`'s `content` field is an open union, and the de-facto
 * writer filling it is Leaflet, whose `pub.leaflet.content` is not text at all:
 * pages of typed blocks, with inline formatting expressed as byte-offset facets
 * over plaintext. No markdown probe will ever find a body in that.
 *
 * So this module flattens the shape directly to HTML. The posture is branch
 * `c`'s: every field is untrusted, unknown block and facet types are skipped
 * quietly, and no input can throw. The output still passes through the
 * sanitizer in `markdown.ts` before it reaches a page — this renderer is not
 * trusted either.
 */

import { asBlobRef } from "./document.js";
import { escapeHtml } from "./markdown.js";

/** What a leaflet body flattens to: HTML for the page, plaintext for excerpts. */
export interface LeafletBody {
  html: string;
  text: string;
}

/** Lists inside lists inside lists… stop somewhere. */
const MAX_LIST_DEPTH = 10;

/** Languages worth emitting as a `language-*` class. Anything else is dropped. */
const LANGUAGE_PATTERN = /^[a-z0-9+#-]+$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

interface Facet {
  byteStart: number;
  byteEnd: number;
  features: Record<string, unknown>[];
}

/** Read one facet, or null when its shape or offsets are unusable. */
function asFacet(value: unknown, byteLength: number): Facet | null {
  const record = asRecord(value);
  if (record === null) return null;
  const index = asRecord(record["index"]);
  if (index === null) return null;
  const byteStart = index["byteStart"];
  const byteEnd = index["byteEnd"];
  if (typeof byteStart !== "number" || typeof byteEnd !== "number") return null;
  if (!Number.isInteger(byteStart) || !Number.isInteger(byteEnd)) return null;
  if (byteStart < 0 || byteEnd <= byteStart || byteEnd > byteLength) return null;
  const features = Array.isArray(record["features"]) ? record["features"] : [];
  return {
    byteStart,
    byteEnd,
    features: features.map(asRecord).filter((f): f is Record<string, unknown> => f !== null),
  };
}

/** The fragment after `#` in a feature's `$type`, or "" when there is none. */
function featureKind(feature: Record<string, unknown>): string {
  const type = feature["$type"];
  if (typeof type !== "string") return "";
  const hash = type.indexOf("#");
  return hash === -1 ? "" : type.slice(hash + 1);
}

/** Wrap already-escaped HTML in the markup one facet feature asks for. */
function applyFeature(html: string, feature: Record<string, unknown>): string {
  switch (featureKind(feature)) {
    case "link": {
      const uri = feature["uri"];
      // http(s) only: the sanitizer would catch `javascript:` later, but a
      // renderer that never emits it has one less property to prove.
      if (typeof uri !== "string" || !/^https?:\/\//i.test(uri)) return html;
      return `<a href="${escapeHtml(uri)}">${html}</a>`;
    }
    case "bold":
      return `<strong>${html}</strong>`;
    case "italic":
      return `<em>${html}</em>`;
    case "code":
      return `<code>${html}</code>`;
    case "strikethrough":
      return `<del>${html}</del>`;
    case "underline":
      return `<u>${html}</u>`;
    case "highlight":
      return `<mark>${html}</mark>`;
    case "didMention": {
      const did = feature["did"];
      if (typeof did !== "string" || !did.startsWith("did:")) return html;
      return `<a href="https://bsky.app/profile/${escapeHtml(did)}">${html}</a>`;
    }
    // footnote, id, atMention, and anything invented later: keep the text,
    // lose the decoration. A missing footnote marker costs nothing; a thrown
    // error costs the post.
    default:
      return html;
  }
}

/**
 * Apply facets to plaintext, producing inline HTML.
 *
 * Facet offsets are **UTF-8 byte** positions, not JS string indices — the two
 * diverge on the first non-ASCII character. So the text is encoded once and
 * every slice happens in byte space; only the final segments are decoded back.
 * Invalid, reversed, or overlapping facets are dropped (first wins), because a
 * facet is a decoration and the plaintext must survive any garbage around it.
 */
export function facetedText(plaintext: string, facets: unknown): string {
  const bytes = new TextEncoder().encode(plaintext);
  const decoder = new TextDecoder();

  const usable: Facet[] = [];
  if (Array.isArray(facets)) {
    const candidates = facets
      .map((f) => asFacet(f, bytes.length))
      .filter((f): f is Facet => f !== null)
      .sort((a, b) => a.byteStart - b.byteStart);
    let end = 0;
    for (const facet of candidates) {
      if (facet.byteStart < end) continue;
      usable.push(facet);
      end = facet.byteEnd;
    }
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const facet of usable) {
    parts.push(escapeHtml(decoder.decode(bytes.subarray(cursor, facet.byteStart))));
    let segment = escapeHtml(decoder.decode(bytes.subarray(facet.byteStart, facet.byteEnd)));
    for (const feature of facet.features) segment = applyFeature(segment, feature);
    parts.push(segment);
    cursor = facet.byteEnd;
  }
  parts.push(escapeHtml(decoder.decode(bytes.subarray(cursor))));
  return parts.join("");
}

/** The part after `pub.leaflet.blocks.`, or "" for anything else. */
function blockKind(block: Record<string, unknown>): string {
  const type = block["$type"];
  if (typeof type !== "string") return "";
  const prefix = "pub.leaflet.blocks.";
  return type.startsWith(prefix) ? type.slice(prefix.length) : "";
}

/** Accumulates HTML and plaintext while walking the block tree. */
interface Sink {
  html: string[];
  text: string[];
}

/** Render one list (ul/ol) of leaflet list items, recursing into children. */
function renderList(tag: "ul" | "ol", children: unknown, sink: Sink, depth: number): string {
  if (!Array.isArray(children) || depth > MAX_LIST_DEPTH) return "";
  const items: string[] = [];
  for (const child of children) {
    const item = asRecord(child);
    if (item === null) continue;
    const content = asRecord(item["content"]);
    const plaintext = content !== null ? content["plaintext"] : undefined;
    let inner = "";
    if (typeof plaintext === "string" && plaintext !== "") {
      inner = facetedText(plaintext, content!["facets"]);
      sink.text.push(plaintext);
    }
    const nested = renderList(tag, item["children"], sink, depth + 1);
    if (inner === "" && nested === "") continue;
    items.push(`<li>${inner}${nested}</li>`);
  }
  return items.length > 0 ? `<${tag}>${items.join("")}</${tag}>` : "";
}

/** Render one block into the sink. Unknown or embed-ish blocks contribute nothing. */
function renderBlock(block: Record<string, unknown>, sink: Sink): void {
  const kind = blockKind(block);
  const plaintext = typeof block["plaintext"] === "string" ? (block["plaintext"] as string) : "";

  switch (kind) {
    case "text": {
      if (plaintext.trim() === "") return;
      sink.html.push(`<p>${facetedText(plaintext, block["facets"])}</p>`);
      sink.text.push(plaintext);
      return;
    }
    case "header": {
      if (plaintext.trim() === "") return;
      // Clamp to h2..h6: the post title is the page's only h1.
      const level = typeof block["level"] === "number" ? block["level"] : 1;
      const h = Math.min(6, Math.max(2, Math.floor(level) + 1));
      sink.html.push(`<h${h}>${facetedText(plaintext, block["facets"])}</h${h}>`);
      sink.text.push(plaintext);
      return;
    }
    case "blockquote": {
      if (plaintext.trim() === "") return;
      sink.html.push(`<blockquote><p>${facetedText(plaintext, block["facets"])}</p></blockquote>`);
      sink.text.push(plaintext);
      return;
    }
    case "code": {
      if (plaintext === "") return;
      const language = block["language"];
      const cls =
        typeof language === "string" && LANGUAGE_PATTERN.test(language)
          ? ` class="language-${escapeHtml(language.toLowerCase())}"`
          : "";
      sink.html.push(`<pre><code${cls}>${escapeHtml(plaintext)}</code></pre>`);
      return;
    }
    case "horizontalRule": {
      sink.html.push("<hr />");
      return;
    }
    case "image": {
      const ref = asBlobRef(block["image"]);
      if (ref === null) return;
      // The `atproto://getBlob?cid=` placeholder is the seam branch `e` cut:
      // `contentCids` finds it so `pull` fetches the blob, the sanitizer's
      // scheme allow-list lets it through, and `rewriteBlobUrls` swaps it for
      // the local asset path after sanitizing.
      const alt = typeof block["alt"] === "string" ? block["alt"] : "";
      sink.html.push(
        `<img src="atproto://getBlob?cid=${escapeHtml(ref.cid)}" alt="${escapeHtml(alt)}" />`,
      );
      return;
    }
    case "unorderedList":
    case "orderedList": {
      const tag = kind === "orderedList" ? "ol" : "ul";
      const html = renderList(tag, block["children"], sink, 1);
      if (html !== "") sink.html.push(html);
      return;
    }
    // iframe, html, bskyPost, website, poll, button, postsList, signup, math,
    // page, membersOnlyDelimiter, and whatever ships next: embeds and controls
    // that cannot be flattened honestly. Skipping them loses a widget, not the
    // words around it.
    default:
      return;
  }
}

/**
 * Flatten a `pub.leaflet.content` body, or return null when `content` is not
 * one — including when it is but nothing in it is renderable, so the caller's
 * `textContent` fallback still applies.
 *
 * Detection is deliberately narrow: the declared `$type`, or a non-empty
 * `pages` array of objects. A future union variant that merely *has* a
 * `blocks` field must not match — that is somebody else's shape.
 */
export function leafletContent(content: unknown): LeafletBody | null {
  const record = asRecord(content);
  if (record === null) return null;
  // `blobPages` means the canonical body lives in pre-rendered blobs and the
  // lexicon says inline pages must then be ignored. We render neither.
  if (record["blobPages"] !== undefined) return null;

  // A declared `$type` with no usable pages falls through here too: with
  // nothing to render, the fallback is more honest than an empty body.
  const pages = record["pages"];
  if (!Array.isArray(pages) || pages.length === 0) return null;
  if (!pages.every((p) => asRecord(p) !== null)) return null;

  const sink: Sink = { html: [], text: [] };
  for (const page of pages) {
    // Only linearDocument pages carry a flat `blocks` list; canvas pages have
    // free-positioned children and no honest linearisation.
    const blocks = asRecord(page)?.["blocks"];
    if (!Array.isArray(blocks)) continue;
    for (const entry of blocks) {
      const wrapper = asRecord(entry);
      if (wrapper === null) continue;
      // Entries are usually `{ block, alignment? }` wrappers; tolerate a bare
      // block too. Alignment is presentation, not content — ignored.
      const block = asRecord(wrapper["block"]) ?? wrapper;
      renderBlock(block, sink);
    }
  }

  const html = sink.html.join("\n");
  if (html.trim() === "") return null;
  return { html, text: sink.text.join("\n\n") };
}
