/**
 * Record text -> HTML.
 *
 * The markdown in a document was written by whoever wrote the record, and
 * markdown permits raw HTML by design. So the output is sanitized against an
 * allow-list before it goes anywhere near a page. This is the same posture as
 * the parser in branch `c`, one layer further along: the content is untrusted,
 * and the fix is to constrain it rather than to trust the source.
 */

import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

/**
 * Tags a document body may use. Everything else is stripped, keeping the text
 * inside it — a `<script>` becomes nothing, a `<marquee>` becomes its content.
 */
const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "img",
  "figure",
  "figcaption",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "sup",
  "sub",
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ["href", "title", "rel"],
    img: ["src", "alt", "title", "loading"],
    code: ["class"], // language-* from fenced blocks
    th: ["colspan", "rowspan"],
    td: ["colspan", "rowspan"],
  },
  // No `javascript:`, no `data:` payloads. `atproto:` is allowed through so
  // branch `e` can rewrite blob URLs after sanitizing.
  allowedSchemes: ["http", "https", "mailto", "atproto"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  transformTags: {
    // Anything leaving the site is untrusted and must not leak the referrer —
    // which matters enormously for the capability URLs in branch `i`.
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: "noopener noreferrer" },
    }),
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: "lazy" } }),
  },
};

/** Escape text for interpolation into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render markdown to sanitized HTML. */
export function renderMarkdown(source: string): string {
  if (source.trim() === "") return "";
  const raw = marked.parse(source, { async: false, gfm: true, breaks: false });
  return sanitizeHtml(raw, SANITIZE_OPTIONS);
}

/** Render plain text as paragraphs, escaping everything. */
export function renderPlainText(source: string): string {
  if (source.trim() === "") return "";
  return source
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block.trim()).replace(/\n/g, "<br />")}</p>`)
    .join("\n");
}

/** Render a document's body according to whether it carried markdown. */
export function renderBody(content: string, isMarkdown: boolean): string {
  return isMarkdown ? renderMarkdown(content) : renderPlainText(content);
}

/** First `limit` characters of the body as plain text, for summaries/feeds. */
export function excerpt(content: string, limit = 200): string {
  const text = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, text.lastIndexOf(" ", limit) || limit).trimEnd()}…`;
}
