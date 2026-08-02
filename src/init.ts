/**
 * `atmo init` — the first two minutes.
 *
 * Writes a working config and nothing else. No templates are copied: branch
 * `d`'s search path means an empty `templates/` already inherits every default,
 * and a scaffold full of files you didn't ask for is a scaffold you have to
 * delete before you can understand anything.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class InitError extends Error {}

export interface InitOptions {
  handle: string;
  title?: string;
  baseUrl?: string;
  /** Overwrite an existing config. */
  force?: boolean;
}

const GITIGNORE_LINES = [
  "# atmo",
  "dist/",
  ".atmo/",
  "",
  "# the age identity for private posts — never commit this",
  ".atmo/identity",
  "",
];

export function configFor(options: InitOptions): string {
  const title = options.title ?? options.handle;
  const baseUrl = options.baseUrl ?? "https://example.com";

  return `# atmo — see https://github.com/j23n/mosaicat

[site]
title    = "${title}"
base_url = "${baseUrl}"

# Your public repo. The handle is resolved: handle -> DID -> PDS.
[[source]]
name        = "posts"
handle      = "${options.handle}"
collections = ["site.standard.document"]

# Other apps' records, rendered as their own pages. Uncomment what you use.
# [[source]]
# name        = "books"
# handle      = "${options.handle}"
# collections = ["buzz.bookhive.book"]

# A private repo on a PDS the internet cannot reach. Output is encrypted and
# served at derived paths. Requires $ATMO_PASSPHRASE at build time, and a build
# host that can route to pds_url — usually your laptop, not CI.
# [[source]]
# name        = "private"
# did         = "did:plc:xxxxxxxxxxxxxxxxxxxxxxxx"
# pds_url     = "http://pds-private:3000"
# visibility  = "encrypted"

# [reactions]
# mode = "client"   # or "off"
`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Create `atmo.toml`, `templates/`, and gitignore entries. */
export async function init(root: string, options: InitOptions): Promise<string[]> {
  if (options.handle.trim() === "") {
    throw new InitError("a handle is required: atmo init <handle>");
  }

  const configPath = join(root, "atmo.toml");
  if (!options.force && (await exists(configPath))) {
    throw new InitError("atmo.toml already exists — pass --force to overwrite");
  }

  const written: string[] = [];

  await mkdir(root, { recursive: true });
  await writeFile(configPath, configFor(options), "utf8");
  written.push("atmo.toml");

  // Empty, but its existence is the hint: put overrides here.
  await mkdir(join(root, "templates"), { recursive: true });
  await writeFile(
    join(root, "templates", ".gitkeep"),
    "# Drop a file named like a built-in template here to override it.\n" +
      "# e.g. post.eta, list.eta, base.eta, atmo.css, collections/<nsid>.eta\n",
    "utf8",
  );
  written.push("templates/.gitkeep");

  const gitignorePath = join(root, ".gitignore");
  const current = (await exists(gitignorePath)) ? await readFile(gitignorePath, "utf8") : "";
  if (!current.includes(".atmo/")) {
    await writeFile(
      gitignorePath,
      `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${GITIGNORE_LINES.join("\n")}`,
      "utf8",
    );
    written.push(".gitignore");
  }

  return written;
}
