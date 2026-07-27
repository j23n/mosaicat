/**
 * `atmo build` — cache in, directory out.
 *
 * Touches no network and reads no clock beyond what the caller injects, so the
 * same cache always produces the same bytes. That is what makes the output
 * testable by comparison, and what lets branch `h` decide whether a build is
 * safe to publish *before* anything is written.
 */

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { BLOB_DIR, blobFilename } from "./blob.js";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { collectionHeading, templateCandidates } from "./collection.js";
import { renderFeed, renderRobots, renderSitemap } from "./feed.js";
import { createRenderer, type Renderer } from "./render.js";
import { BUILTIN_TEMPLATES } from "./render.js";
import { absolute, loadSite, type Page, type SiteModel } from "./site.js";

export interface BuildOptions {
  projectRoot?: string;
  /** Injected so tests are deterministic. */
  renderer?: Renderer;
  log?: (line: string) => void;
}

export interface BuildResult {
  site: SiteModel;
  /** Site-absolute paths written, in order. */
  written: string[];
}

/** Write a file, creating parents. `path` is site-absolute (`/a/b/`). */
async function emit(outDir: string, path: string, contents: string): Promise<string> {
  const relative = path.endsWith("/") ? `${path}index.html` : path;
  const target = join(outDir, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
  return relative;
}

function atUri(page: Page): string {
  return `https://pdsls.dev/${page.doc.uri}`;
}

export async function build(config: Config, options: BuildOptions = {}): Promise<BuildResult> {
  const { projectRoot = ".", log = () => {} } = options;
  const renderer = options.renderer ?? createRenderer(projectRoot);
  const site = await loadSite(config);
  const written: string[] = [];

  // A fresh directory each time: a stale file from a deleted post would
  // otherwise stay served forever, and nothing would ever tell you.
  await rm(config.out_dir, { recursive: true, force: true });
  await mkdir(config.out_dir, { recursive: true });

  const emitPage = async (path: string, contents: string) => {
    written.push(await emit(config.out_dir, path, contents));
  };

  for (const paginated of site.index) {
    const body = renderer.render("list.eta", {
      pages: paginated.pages,
      pagination: paginated,
      tags: paginated.number === 1 ? site.tags : [],
      heading: null,
    });
    await emitPage(
      paginated.url,
      renderer.page({
        title: site.config.site.title,
        description: site.config.site.description,
        canonical: absolute(config.site.base_url, paginated.url),
        site: site.config.site,
        body,
      }),
    );
  }

  for (const page of site.publicPages) {
    const body = renderer.render("post.eta", { page, atUri: atUri(page) });
    await emitPage(
      page.url,
      renderer.page({
        title: `${page.doc.title || "Untitled"} — ${site.config.site.title}`,
        description: page.summary,
        canonical: absolute(config.site.base_url, page.url),
        site: site.config.site,
        body,
      }),
    );
  }

  for (const tag of site.tags) {
    const body = renderer.render("list.eta", {
      pages: tag.pages,
      pagination: null,
      tags: [],
      heading: `#${tag.tag.name}`,
    });
    await emitPage(
      tag.url,
      renderer.page({
        title: `#${tag.tag.name} — ${site.config.site.title}`,
        canonical: absolute(config.site.base_url, tag.url),
        site: site.config.site,
        body,
      }),
    );
  }

  for (const collection of site.collections) {
    const template = renderer.findTemplate(templateCandidates(collection.nsid));
    if (template === null) continue;
    const heading = collectionHeading(collection.nsid);
    const body = renderer.render(template, {
      items: collection.items,
      nsid: collection.nsid,
      heading,
    });
    await emitPage(
      collection.url,
      renderer.page({
        title: `${heading} — ${site.config.site.title}`,
        canonical: absolute(config.site.base_url, collection.url),
        site: site.config.site,
        body,
      }),
    );
  }

  await emitPage("/feed.xml", renderFeed(site));
  await emitPage("/sitemap.xml", renderSitemap(site));
  await emitPage("/robots.txt", renderRobots(site));

  // Stylesheet: the project's override if present, otherwise the default.
  const cssSource = renderer.resolveTemplate("atmo.css");
  const cssTarget = join(config.out_dir, "assets", "atmo.css");
  await mkdir(dirname(cssTarget), { recursive: true });
  await cp(cssSource, cssTarget);
  written.push("/assets/atmo.css");

  // Blobs: copy from the cache rather than refetching. `build` has no network.
  for (const blob of site.blobs) {
    const name = blobFilename(blob.cid, blob.mimeType);
    const target = join(config.out_dir, "assets", "blobs", name);
    await mkdir(dirname(target), { recursive: true });
    try {
      await cp(join(config.cache_dir, BLOB_DIR, name), target);
      written.push(`/assets/blobs/${name}`);
    } catch {
      // Recorded in the cache but missing on disk: skip it. A broken image is
      // survivable; refusing to build over one is not proportionate.
    }
  }

  log(`${written.length} file(s) -> ${config.out_dir}`);
  return { site, written };
}

export { BUILTIN_TEMPLATES };
