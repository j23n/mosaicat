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
import {
  GuardError,
  hasErrors,
  inspect,
  manifestFor,
  readManifest,
  writeManifest,
  type GuardFinding,
} from "./guard.js";
import {
  emitPrivate,
  loadSiteKeys,
  passphraseFromEnv,
  PrivateError,
  privatePagesOf,
} from "./private.js";
import { createRenderer, type Renderer } from "./render.js";
import { BUILTIN_TEMPLATES } from "./render.js";
import { absolute, loadSite, type Page, type SiteModel } from "./site.js";

export interface BuildOptions {
  projectRoot?: string;
  /** Injected so tests are deterministic. */
  renderer?: Renderer;
  log?: (line: string) => void;
  /** Publish even when a guard would refuse. */
  force?: boolean;
  now?: () => Date;
}

export interface BuildResult {
  site: SiteModel;
  /** Site-absolute paths written, in order. */
  written: string[];
  findings: GuardFinding[];
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

  // Inspect BEFORE writing anything: a refused build must leave the previous
  // output untouched, so whatever is deployed stays deployed.
  const previous = await readManifest(config.cache_dir);
  const findings = inspect(site, { force: options.force ?? false, previous });
  if (hasErrors(findings)) throw new GuardError(findings);

  const written: string[] = [];

  // A fresh directory each time: a stale file from a deleted post would
  // otherwise stay served forever, and nothing would ever tell you.
  await rm(config.out_dir, { recursive: true, force: true });
  await mkdir(config.out_dir, { recursive: true });

  const emitPage = async (path: string, contents: string) => {
    written.push(await emit(config.out_dir, path, contents));
  };

  // Collection pages are reachable from nowhere unless the header links them,
  // so a nav exists exactly when there are collections. A posts-only site gets
  // none — a lone "Home" link pointing at itself is noise. The private half
  // (`emitPrivate`) builds its own contexts and deliberately has no nav.
  const navEntries = [
    { label: "Home", url: "/" },
    ...site.collections.map((c) => ({ label: collectionHeading(c.nsid), url: c.url })),
  ].filter((entry, i, all) => all.findIndex((e) => e.url === entry.url) === i);
  const nav = site.collections.length > 0 ? { nav: navEntries } : {};

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
        ...nav,
        site: site.config.site,
        body,
      }),
    );
  }

  for (const page of site.publicPages) {
    const canonical = absolute(config.site.base_url, page.url);
    const body = renderer.render("post.eta", {
      page,
      atUri: atUri(page),
      canonical,
      bskyUri: page.doc.bskyPostUri,
      reactions: config.reactions,
    });
    await emitPage(
      page.url,
      renderer.page({
        title: `${page.doc.title || "Untitled"} — ${site.config.site.title}`,
        description: page.summary,
        canonical,
        ...(page.coverUrl !== null ? { image: absolute(config.site.base_url, page.coverUrl) } : {}),
        ...nav,
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
        ...nav,
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
        ...nav,
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

  const privatePages = privatePagesOf(config, site);
  if (privatePages.length > 0) {
    const passphrase = passphraseFromEnv();
    if (passphrase === null) {
      throw new PrivateError(
        `${privatePages.length} private page(s) to encrypt but $ATMO_PASSPHRASE is not set`,
      );
    }
    const keys = await loadSiteKeys(config, passphrase);
    const emitted = await emitPrivate(config, site, renderer, keys, privatePages);
    written.push(...emitted.written);

    const decryptSource = renderer.resolveTemplate("decrypt.js");
    const decryptTarget = join(config.out_dir, "assets", "decrypt.js");
    await mkdir(dirname(decryptTarget), { recursive: true });
    await cp(decryptSource, decryptTarget);
    written.push("/assets/decrypt.js");
    log(`${emitted.posts} private page(s) encrypted`);
  }

  if (config.reactions.mode === "client") {
    const source = renderer.resolveTemplate("reactions.js");
    const target = join(config.out_dir, "assets", "reactions.js");
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
    written.push("/assets/reactions.js");
  }

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

  const now = (options.now ?? (() => new Date()))();
  await writeManifest(config.cache_dir, manifestFor(site, now));

  log(`${written.length} file(s) -> ${config.out_dir}`);
  return { site, written, findings };
}

export { BUILTIN_TEMPLATES };
