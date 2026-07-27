/**
 * The config file is atmo's entire public surface.
 *
 * One TOML file describes the site and the repos it renders from. Everything
 * downstream (pull, normalize, render, encrypt) reads the parsed, normalized
 * result of this module and nothing else — there is no ambient state and no
 * second place to look.
 */

import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

/** The document lexicon atmo renders as posts. */
export const DOCUMENT_NSID = "site.standard.document";

/** The publication lexicon a document's `site` field points at. */
export const PUBLICATION_NSID = "site.standard.publication";

const SiteSchema = z.object({
  title: z.string().min(1),
  /** Absolute origin the site is served from; trailing slash is stripped. */
  base_url: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, "")),
  description: z.string().default(""),
});

const SourceSchema = z
  .object({
    /** Stable key; also the cache partition and the config's own handle on it. */
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase alphanumeric with dashes"),

    /**
     * Identity, one of two ways:
     *   handle             -> resolved over the network (handle -> DID -> PDS)
     *   did + pds_url      -> used verbatim, no resolution
     *
     * The second form is what makes an unreachable PDS usable: a private repo
     * has no public handle to resolve, so the pair must be supplied. Requiring
     * BOTH halves is deliberate — see the refinement below.
     */
    handle: z.string().min(1).optional(),
    did: z.string().startsWith("did:").optional(),
    pds_url: z.string().url().optional(),

    collections: z.array(z.string().min(1)).default([DOCUMENT_NSID]),

    /**
     * Publication rkey this source's documents must belong to. Records that
     * positively claim a *different* publication in the same repo are skipped,
     * which is how drafts and posts share one repo.
     */
    publication: z.string().default("self"),

    /** `public` emits normally; `encrypted` routes through the private path. */
    visibility: z.enum(["public", "encrypted"]).default("public"),

    /**
     * URL prefix this source's documents render under. Defaults to the source
     * name, so two sources can never silently collide.
     */
    path_prefix: z.string().optional(),

    /** Cap on records fetched per collection, so one repo can't stall a build. */
    max_records: z.number().int().positive().default(1000),
  })
  .refine((s) => s.handle !== undefined || (s.did !== undefined && s.pds_url !== undefined), {
    message:
      "a source needs either `handle`, or both `did` and `pds_url` (a half-configured " +
      "identity would fail at fetch time instead of never existing)",
  });

const ConfigSchema = z.object({
  site: SiteSchema,
  source: z.array(SourceSchema).min(1),
  cache_dir: z.string().default(".atmo/cache"),
  out_dir: z.string().default("dist"),
  /** Documents per index page. */
  page_size: z.number().int().positive().default(10),
});

export type Site = z.infer<typeof SiteSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

/** Parse and validate TOML text. Throws `ConfigError` with a readable report. */
export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    throw new ConfigError(`could not parse TOML: ${(e as Error).message}`);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `  ${path}: ${i.message}`;
    });
    throw new ConfigError(`invalid config:\n${lines.join("\n")}`);
  }

  const config = result.data;

  const seen = new Set<string>();
  for (const source of config.source) {
    if (seen.has(source.name)) {
      throw new ConfigError(`invalid config:\n  source: duplicate name "${source.name}"`);
    }
    seen.add(source.name);
  }

  return config;
}

/** Read and validate a config file from disk. */
export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ConfigError(`no config file at ${path}`);
  }
  return parseConfig(text);
}
