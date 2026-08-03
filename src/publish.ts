/**
 * `atmo publish` / `atmo unpublish` — the write side of the pipeline.
 *
 * A third network verb, deliberately separate from the other two: it never
 * touches the cache or `dist/`. Local markdown files become
 * `site.standard.document` records; the assigned rkey is written back into
 * the file's frontmatter, which is also the only unpublish mechanism — you
 * can only unpublish what this workflow published.
 *
 * Everything is validated before anything is sent: one bad file aborts the
 * whole batch with zero network calls. A failure mid-batch propagates, and
 * files already published keep their writeback — the frontmatter always
 * reflects what actually landed.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { mimeForFilename } from "./blob.js";
import {
  ConfigError,
  DOCUMENT_NSID,
  PUBLICATION_NSID,
  type Config,
  type Source,
} from "./config.js";
import { slugify } from "./document.js";
import {
  FrontmatterError,
  parseFrontmatter,
  removeFrontmatterKey,
  setFrontmatterValue,
  type Frontmatter,
} from "./frontmatter.js";
import { resolveSource, type Identity, type ResolveOptions } from "./identity.js";
import { stripMarkdown } from "./markdown.js";
import {
  appPasswordFromEnv,
  AuthError,
  createRecord,
  createSession,
  deleteRecord,
  putRecord,
  uploadBlob,
  type Session,
  type UploadedBlob,
  type WriteOptions,
} from "./write.js";

export interface PublishOptions extends ResolveOptions {
  /** Injected so tests get deterministic timestamps. */
  now?: () => Date;
  /** Injected env, like `passphraseFromEnv` — never read ambiently. */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** `--source`: required when the config has more than one source. */
  sourceName?: string;
  /** Plan only: no session, no writes. */
  dryRun?: boolean;
}

export interface WriteResult {
  /** The markdown file, as given. */
  path: string;
  /** AT-URI the action landed at ("" when a dry run cannot know it yet). */
  uri: string;
  action: "created" | "updated" | "deleted" | "would create" | "would update" | "would delete";
}

/** Resolve `--source` against the config: exactly one match, or `ConfigError`. */
export function targetSource(config: Config, name: string | undefined): Source {
  if (name !== undefined) {
    const source = config.source.find((s) => s.name === name);
    if (source === undefined) throw new ConfigError(`no source named "${name}" in the config`);
    return source;
  }
  const only = config.source[0];
  if (config.source.length !== 1 || only === undefined) {
    throw new ConfigError(
      `config has ${config.source.length} sources; pass --source to pick one of ` +
        config.source.map((s) => `"${s.name}"`).join(", "),
    );
  }
  return only;
}

/** A body image with a relative URL, to be uploaded and rewritten. */
interface LocalImage {
  /** The URL exactly as written in the markdown. */
  url: string;
  /** Resolved against the markdown file's directory. */
  absPath: string;
}

/** One file, parsed and pre-flight-checked, ready for the network phase. */
interface PreparedFile {
  filePath: string;
  raw: string;
  frontmatter: Frontmatter;
  body: string;
  slug: string;
  images: LocalImage[];
  /** Absolute path of the cover file, when the frontmatter names one. */
  coverPath: string | null;
}

const IMAGE_PATTERN = /(!\[[^\]]*\]\(\s*)([^)\s]+)([^)]*\))/g;

/** True for `./x.jpg` or `img/y.png`; false for schemes, anchors, absolutes. */
function isRelativeUrl(url: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false; // http:, https:, atproto:, …
  return !url.startsWith("/") && !url.startsWith("#");
}

/** Every distinct relative image URL in a markdown body. */
function localImages(filePath: string, body: string): LocalImage[] {
  const images = new Map<string, LocalImage>();
  for (const match of body.matchAll(IMAGE_PATTERN)) {
    const url = match[2]!;
    if (!isRelativeUrl(url) || images.has(url)) continue;
    images.set(url, { url, absPath: resolve(dirname(filePath), url) });
  }
  return [...images.values()];
}

/** Rewrite relative image URLs to the `atproto://getBlob?cid=` form pull round-trips. */
function rewriteImageUrls(body: string, cidByUrl: Map<string, string>): string {
  return body.replace(IMAGE_PATTERN, (whole, open: string, url: string, close: string) => {
    const cid = cidByUrl.get(url);
    if (cid === undefined) return whole;
    return `${open}atproto://getBlob?cid=${cid}${close}`;
  });
}

async function assertFileExists(filePath: string, kind: string, target: string): Promise<void> {
  try {
    await stat(target);
  } catch {
    throw new FrontmatterError(`${filePath}: ${kind} not found: ${target}`);
  }
}

/**
 * Parse and pre-flight one file: strict frontmatter, the source pin, and the
 * existence of every referenced image — all before any network call.
 */
async function prepareFile(filePath: string, source: Source): Promise<PreparedFile> {
  const raw = await readFile(filePath, "utf8").catch(() => {
    throw new FrontmatterError(`${filePath}: cannot read file`);
  });
  const { frontmatter, body } = parseFrontmatter(filePath, raw);

  if (frontmatter.source !== undefined && frontmatter.source !== source.name) {
    throw new FrontmatterError(
      `${filePath}: pinned to source "${frontmatter.source}" but publishing to "${source.name}"`,
    );
  }

  const slug =
    frontmatter.slug !== undefined && frontmatter.slug !== ""
      ? slugify(frontmatter.slug)
      : slugify(basename(filePath).replace(/\.[^.]*$/, ""));
  if (slug === "") {
    throw new FrontmatterError(
      `${filePath}: cannot derive a slug from the filename or frontmatter`,
    );
  }

  const images = localImages(filePath, body);
  for (const image of images) await assertFileExists(filePath, "image", image.absPath);

  const coverPath =
    frontmatter.cover !== undefined ? resolve(dirname(filePath), frontmatter.cover) : null;
  if (coverPath !== null) await assertFileExists(filePath, "cover", coverPath);

  return { filePath, raw, frontmatter, body, slug, images, coverPath };
}

const writeShared = (options: PublishOptions): WriteOptions => ({
  ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
});

/** Sign in to the target source's PDS, or fail with `AuthError` (exit 6). */
async function openSession(
  source: Source,
  identity: Identity,
  options: PublishOptions,
): Promise<Session> {
  const password = appPasswordFromEnv(source.name, options.env);
  if (password === null) {
    throw new AuthError(
      `no app password for source "${source.name}": set ` +
        `ATMO_APP_PASSWORD_${source.name.toUpperCase().replace(/-/g, "_")} or ATMO_APP_PASSWORD`,
    );
  }
  return createSession(identity, password, writeShared(options));
}

/** Build the record for one prepared file. `content` has its URLs rewritten. */
function buildRecord(
  prepared: PreparedFile,
  content: string,
  publishedAt: Date,
  now: () => Date,
  siteUri: string,
  cover: UploadedBlob | null,
): Record<string, unknown> {
  const { frontmatter } = prepared;
  const isUpdate = frontmatter.rkey !== undefined;
  return {
    $type: DOCUMENT_NSID,
    title: frontmatter.title,
    path: `/${prepared.slug}`,
    content,
    textContent: stripMarkdown(content),
    publishedAt: publishedAt.toISOString(),
    ...(isUpdate ? { updatedAt: now().toISOString() } : {}),
    ...(frontmatter.description !== undefined ? { description: frontmatter.description } : {}),
    ...(frontmatter.tags !== undefined ? { tags: frontmatter.tags } : {}),
    ...(siteUri !== "" ? { site: siteUri } : {}),
    ...(cover !== null ? { coverImage: cover } : {}),
  };
}

/** Publish each file as a `site.standard.document`, writing rkeys back. */
export async function publish(
  config: Config,
  files: string[],
  options: PublishOptions = {},
): Promise<WriteResult[]> {
  const { now = () => new Date(), log = () => {}, dryRun = false } = options;
  const source = targetSource(config, options.sourceName);

  // Validate the whole batch before the first network call.
  const prepared: PreparedFile[] = [];
  for (const file of files) prepared.push(await prepareFile(file, source));

  if (dryRun) {
    const results: WriteResult[] = [];
    for (const p of prepared) {
      const action = p.frontmatter.rkey !== undefined ? "would update" : "would create";
      const summary = {
        title: p.frontmatter.title,
        path: `/${p.slug}`,
        ...(p.frontmatter.tags !== undefined ? { tags: p.frontmatter.tags } : {}),
        ...(p.frontmatter.rkey !== undefined ? { rkey: p.frontmatter.rkey } : {}),
      };
      log(`[dry-run] ${action} ${p.filePath}: ${JSON.stringify(summary)}`);
      for (const image of p.images) log(`[dry-run]   would upload ${image.url}`);
      if (p.coverPath !== null) log(`[dry-run]   would upload cover ${p.frontmatter.cover}`);
      results.push({ path: p.filePath, uri: "", action });
    }
    return results;
  }

  const identity = await resolveSource(source, options);
  const session = await openSession(source, identity, options);
  const siteUri =
    source.publication !== ""
      ? `at://${identity.did}/${PUBLICATION_NSID}/${source.publication}`
      : "";

  const results: WriteResult[] = [];
  for (const p of prepared) {
    const cidByUrl = new Map<string, string>();
    for (const image of p.images) {
      const blob = await uploadBlob(
        session,
        await readFile(image.absPath),
        mimeForFilename(image.absPath),
        writeShared(options),
      );
      cidByUrl.set(image.url, blob.ref.$link);
      log(`  ${p.filePath}: uploaded ${image.url} (${blob.ref.$link})`);
    }

    let cover: UploadedBlob | null = null;
    if (p.coverPath !== null) {
      cover = await uploadBlob(
        session,
        await readFile(p.coverPath),
        mimeForFilename(p.coverPath),
        writeShared(options),
      );
      log(`  ${p.filePath}: uploaded cover (${cover.ref.$link})`);
    }

    const publishedAt = p.frontmatter.published ?? now();
    const content = rewriteImageUrls(p.body, cidByUrl);
    const record = buildRecord(p, content, publishedAt, now, siteUri, cover);

    let uri: string;
    let action: WriteResult["action"];
    let rkeyToWrite: string | null = null;
    if (p.frontmatter.rkey !== undefined) {
      ({ uri } = await putRecord(
        session,
        DOCUMENT_NSID,
        p.frontmatter.rkey,
        record,
        writeShared(options),
      ));
      action = "updated";
    } else {
      const created = await createRecord(session, DOCUMENT_NSID, record, writeShared(options));
      uri = created.uri;
      rkeyToWrite = created.rkey;
      action = "created";
    }

    // Success writeback: the file now records where (and when) it landed.
    let text = p.raw;
    if (rkeyToWrite !== null) text = setFrontmatterValue(text, "rkey", JSON.stringify(rkeyToWrite));
    if (p.frontmatter.published === undefined) {
      text = setFrontmatterValue(text, "published", publishedAt.toISOString());
    }
    if (text !== p.raw) await writeFile(p.filePath, text, "utf8");

    log(`${action} ${p.filePath} -> ${uri}`);
    results.push({ path: p.filePath, uri, action });
  }

  return results;
}

/** Delete each file's record (by its written-back rkey) and strip the rkey. */
export async function unpublish(
  config: Config,
  files: string[],
  options: PublishOptions = {},
): Promise<WriteResult[]> {
  const { log = () => {}, dryRun = false } = options;
  const source = targetSource(config, options.sourceName);

  const prepared: PreparedFile[] = [];
  for (const file of files) {
    const p = await prepareFile(file, source);
    if (p.frontmatter.rkey === undefined) {
      throw new FrontmatterError(
        `${file}: no rkey in the frontmatter — only files published by atmo can be unpublished`,
      );
    }
    prepared.push(p);
  }

  // Resolving identity is a read; the pre-flight names exactly what will go.
  const identity = await resolveSource(source, options);
  const planned = prepared.map((p) => ({
    prepared: p,
    uri: `at://${identity.did}/${DOCUMENT_NSID}/${p.frontmatter.rkey}`,
  }));
  for (const { prepared: p, uri } of planned) {
    log(`${dryRun ? "[dry-run] would delete" : "will delete"} ${uri} (${p.filePath})`);
  }
  if (dryRun) {
    return planned.map(({ prepared: p, uri }) => ({
      path: p.filePath,
      uri,
      action: "would delete",
    }));
  }

  const session = await openSession(source, identity, options);

  const results: WriteResult[] = [];
  for (const { prepared: p, uri } of planned) {
    await deleteRecord(session, DOCUMENT_NSID, p.frontmatter.rkey!, writeShared(options));
    const text = removeFrontmatterKey(p.raw, "rkey");
    if (text !== p.raw) await writeFile(p.filePath, text, "utf8");
    log(`deleted ${p.filePath} -> ${uri}`);
    results.push({ path: p.filePath, uri, action: "deleted" });
  }

  return results;
}
