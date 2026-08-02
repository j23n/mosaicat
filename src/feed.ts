/**
 * RSS and sitemap.
 *
 * Both are plain strings built from the site model, and both take
 * `publicPages` — never `pages`. A feed or sitemap that enumerated private
 * posts would hand out exactly the list branch `i` works to keep unguessable.
 */

import { escapeHtml } from "./markdown.js";
import { absolute, type SiteModel } from "./site.js";

function rfc822(date: Date): string {
  return date.toUTCString();
}

/** RSS 2.0. Summaries only — the body may contain markup a reader won't like. */
export function renderFeed(site: SiteModel, limit = 20): string {
  const { base_url: baseUrl, title, description } = site.config.site;
  const items = site.publicPages.slice(0, limit).map((page) => {
    const url = absolute(baseUrl, page.url);
    return [
      "    <item>",
      `      <title>${escapeHtml(page.doc.title || "Untitled")}</title>`,
      `      <link>${escapeHtml(url)}</link>`,
      `      <guid isPermaLink="true">${escapeHtml(url)}</guid>`,
      `      <pubDate>${rfc822(page.doc.publishedAt)}</pubDate>`,
      page.summary !== "" ? `      <description>${escapeHtml(page.summary)}</description>` : "",
      "    </item>",
    ]
      .filter(Boolean)
      .join("\n");
  });

  const latest = site.publicPages[0]?.doc.publishedAt ?? new Date(0);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(title)}</title>
    <link>${escapeHtml(baseUrl)}</link>
    <description>${escapeHtml(description)}</description>
    <lastBuildDate>${rfc822(latest)}</lastBuildDate>
    <atom:link href="${escapeHtml(absolute(baseUrl, "/feed.xml"))}" rel="self" type="application/rss+xml" />
${items.join("\n")}
  </channel>
</rss>
`;
}

export function renderSitemap(site: SiteModel): string {
  const { base_url: baseUrl } = site.config.site;
  const urls = [
    ...site.index.map((p) => ({ loc: p.url, lastmod: site.publicPages[0]?.doc.updatedAt })),
    ...site.publicPages.map((p) => ({ loc: p.url, lastmod: p.doc.updatedAt })),
    ...site.tags.map((t) => ({ loc: t.url, lastmod: t.pages[0]?.doc.updatedAt })),
    // Encrypted sources never reach `site.collections`, so this stays public.
    ...site.collections.map((c) => ({ loc: c.url, lastmod: c.items[0]?.at ?? undefined })),
  ];

  const entries = urls.map(({ loc, lastmod }) =>
    [
      "  <url>",
      `    <loc>${escapeHtml(absolute(baseUrl, loc))}</loc>`,
      lastmod ? `    <lastmod>${lastmod.toISOString().slice(0, 10)}</lastmod>` : "",
      "  </url>",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`;
}

/** robots.txt — disallows the private prefix branch `i` will use. */
export function renderRobots(site: SiteModel): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /p/",
    "",
    `Sitemap: ${absolute(site.config.site.base_url, "/sitemap.xml")}`,
    "",
  ].join("\n");
}
