/**
 * Emitting the private half of a site.
 *
 * Three kinds of file, none of which reveals anything without the passphrase:
 *
 *   /private/                 public entry page. A prompt and the wrapped
 *                             identity. Contains NO post URLs.
 *   /p/<derived-index>/       the encrypted manifest (titles + rkeys)
 *   /p/<derived-rkey>/        one encrypted post
 *
 * The entry page is archivable and harmless. Everything else lives at a path
 * derived from the identity, so the URLs cannot be enumerated, guessed, or
 * discovered by crawling — and the contents are encrypted anyway.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import {
  createSiteKeys,
  derivePath,
  encryptTo,
  MANIFEST_LABEL,
  postLabel,
  siteKeysFrom,
  toBase64,
  type SiteKeys,
} from "./crypto.js";
import type { Renderer } from "./render.js";
import type { Page, SiteModel } from "./site.js";

export class PrivateError extends Error {}

/** Env var carrying the passphrase. Never a config value — it's a secret. */
export const PASSPHRASE_ENV = "ATMO_PASSPHRASE";

/**
 * Load the site identity, creating it on first use.
 *
 * It must persist: a fresh identity every build would change every derived
 * path, breaking links you have already shared. The file holds the secret half
 * and must never be committed or deployed.
 */
export async function loadSiteKeys(config: Config, passphrase: string): Promise<SiteKeys> {
  const path = config.private.identity_file;
  try {
    const identity = (await readFile(path, "utf8")).trim();
    if (identity !== "") return await siteKeysFrom(identity, passphrase);
  } catch {
    // Not there yet: fall through and create one.
  }
  const keys = await createSiteKeys(passphrase);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${keys.identity}\n`, { encoding: "utf8", mode: 0o600 });
  return keys;
}

export function passphraseFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[PASSPHRASE_ENV];
  return value !== undefined && value.trim() !== "" ? value : null;
}

export interface PrivateEmit {
  /** Site-absolute paths written. */
  written: string[];
  posts: number;
}

interface ManifestEntry {
  rkey: string;
  title: string;
  publishedAt: string;
}

async function writeFileAt(outDir: string, path: string, data: string | Uint8Array) {
  const target = join(outDir, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}

/**
 * Encrypt and emit every page belonging to an `encrypted` source.
 *
 * The *rendered, sanitized* HTML is what gets encrypted — the same pipeline
 * every public page goes through — so the browser never has to sanitize
 * anything it decrypts.
 */
export async function emitPrivate(
  config: Config,
  site: SiteModel,
  renderer: Renderer,
  keys: SiteKeys,
  privatePages: Page[],
): Promise<PrivateEmit> {
  const written: string[] = [];
  const wrapped = toBase64(keys.wrapped);

  const shell = (mode: "index" | "post", heading: string, title: string) =>
    renderer.page({
      title,
      site: config.site,
      noindex: true, // also emits <meta name="referrer" content="no-referrer">
      body: renderer.render("private.eta", { mode, heading, wrapped }),
    });

  // Public entry point. Deliberately contains no post URLs at all.
  const entry = config.private.entry_path;
  await writeFileAt(config.out_dir, `${entry}index.html`, shell("index", "Private", "Private"));
  written.push(`${entry}index.html`);

  const manifest: ManifestEntry[] = privatePages.map((page) => ({
    rkey: page.doc.rkey,
    title: page.doc.title,
    publishedAt: page.doc.publishedAt.toISOString(),
  }));

  const manifestPath = await derivePath(keys.identity, MANIFEST_LABEL);
  await writeFileAt(
    config.out_dir,
    `/p/${manifestPath}/payload.age`,
    await encryptTo(keys.recipient, JSON.stringify(manifest)),
  );
  written.push(`/p/${manifestPath}/payload.age`);

  for (const page of privatePages) {
    const path = await derivePath(keys.identity, postLabel(page.doc.rkey));
    const body = renderer.render("post.eta", {
      page,
      atUri: `https://pdsls.dev/${page.doc.uri}`,
      canonical: "",
      bskyUri: "",
      // Never phone a third party from a private page.
      reactions: { mode: "off" },
    });

    await writeFileAt(
      config.out_dir,
      `/p/${path}/payload.age`,
      await encryptTo(keys.recipient, body),
    );
    // The shell is generic: identical for every post, so its size and content
    // reveal nothing about which post it holds.
    await writeFileAt(config.out_dir, `/p/${path}/index.html`, shell("post", "Private", "Private"));
    written.push(`/p/${path}/payload.age`, `/p/${path}/index.html`);
  }

  return { written, posts: privatePages.length };
}

/** Pages belonging to sources marked `encrypted`. */
export function privatePagesOf(config: Config, site: SiteModel): Page[] {
  const encrypted = new Set(
    config.source.filter((s) => s.visibility === "encrypted").map((s) => s.name),
  );
  return site.pages.filter((page) => encrypted.has(page.doc.source));
}
