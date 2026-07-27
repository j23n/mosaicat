#!/usr/bin/env node
/**
 * The `atmo` command.
 *
 * Subcommands are deliberately split so that the two halves fail
 * independently: `pull` is the only thing that touches the network, `build`
 * is the only thing that writes output. A build can therefore never be broken
 * by a slow PDS, and template iteration never re-fetches.
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "./config.js";
import { HttpError } from "./http.js";
import { IdentityError } from "./identity.js";
import { build } from "./build.js";
import { GuardError, inspect, readManifest } from "./guard.js";
import { init, InitError } from "./init.js";
import { PrivateError } from "./private.js";
import { loadSite } from "./site.js";
import { pull } from "./pull.js";

const USAGE = `atmo — a static site generator for an ATProto repo

usage:
  atmo init    <handle>            create atmo.toml in the current directory
  atmo pull    [--config <path>]   fetch records and blobs into the cache
  atmo build   [--config <path>]   render the cache into the output directory
  atmo doctor  [--config <path>]   check config, cache and model health

options:
  -c, --config <path>   config file (default: atmo.toml)
  -f, --force           build even when a guard would refuse; overwrite on init
      --title <text>    site title (init)
      --base-url <url>  public origin (init)
  -h, --help            show this help
  -V, --version         show version
`;

const VERSION = "0.0.0";

type Command = "init" | "pull" | "build" | "doctor";

const COMMANDS = new Set<Command>(["init", "pull", "build", "doctor"]);

function isCommand(value: string): value is Command {
  return COMMANDS.has(value as Command);
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", short: "c", default: "atmo.toml" },
      force: { type: "boolean", short: "f", default: false },
      title: { type: "string" },
      "base-url": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "V", default: false },
    },
    allowPositionals: true,
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const command = positionals[0];

  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }

  if (!isCommand(command)) {
    process.stderr.write(`atmo: unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }

  // `init` runs before a config exists, so it is handled ahead of the load.
  if (command === "init") {
    try {
      const written = await init(process.cwd(), {
        handle: positionals[1] ?? "",
        force: values.force,
        ...(values.title !== undefined ? { title: values.title } : {}),
        ...(values["base-url"] !== undefined ? { baseUrl: values["base-url"] } : {}),
      });
      for (const file of written) process.stdout.write(`created ${file}\n`);
      process.stdout.write("\nnext: atmo pull && atmo build\n");
      return 0;
    } catch (e) {
      if (e instanceof InitError) {
        process.stderr.write(`atmo: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
  }

  try {
    const config = await loadConfig(values.config);

    switch (command) {
      case "doctor":
        return await doctor(config);
      case "pull": {
        const results = await pull(config, { log: (l) => process.stdout.write(`${l}\n`) });
        const total = results.reduce((n, r) => n + r.records, 0);
        process.stdout.write(`\npulled ${total} record(s) into ${config.cache_dir}\n`);
        return 0;
      }
      case "build": {
        const result = await build(config, {
          log: (l) => process.stdout.write(`${l}\n`),
          force: values.force,
        });
        for (const finding of result.findings) {
          process.stderr.write(`atmo: warning: ${finding.message}\n`);
        }
        return 0;
      }
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`atmo: ${e.message}\n`);
      return 2;
    }
    if (e instanceof IdentityError || e instanceof HttpError) {
      process.stderr.write(`atmo: ${e.message}\n`);
      return 3;
    }
    if (e instanceof PrivateError) {
      process.stderr.write(`atmo: ${e.message}\n`);
      return 5;
    }
    if (e instanceof GuardError) {
      for (const finding of e.findings) {
        process.stderr.write(`atmo: ${finding.severity}: ${finding.message}\n`);
      }
      process.stderr.write("atmo: build refused; nothing was written\n");
      return 4;
    }
    throw e;
  }
}

async function doctor(config: Awaited<ReturnType<typeof loadConfig>>): Promise<number> {
  process.stdout.write(`site:  ${config.site.title} <${config.site.base_url}>\n`);
  process.stdout.write(`cache: ${config.cache_dir}\nout:   ${config.out_dir}\n\n`);

  for (const source of config.source) {
    const identity =
      source.handle !== undefined ? source.handle : `${source.did} @ ${source.pds_url}`;
    process.stdout.write(
      `source "${source.name}" [${source.visibility}]\n` +
        `  identity:    ${identity}\n` +
        `  collections: ${source.collections.join(", ")}\n` +
        `  publication: ${source.publication}\n`,
    );
  }

  process.stdout.write(`\nconfig is valid (${config.source.length} source(s))\n`);

  const site = await loadSite(config);
  const previous = await readManifest(config.cache_dir);

  process.stdout.write(
    `\ncache:  ${site.pages.length} page(s), ${site.collections.length} collection(s), ` +
      `${site.blobs.length} blob(s)\n`,
  );
  if (previous !== null) {
    process.stdout.write(`last build: ${previous.pages} page(s) at ${previous.builtAt}\n`);
  }

  const findings = inspect(site, { previous });
  if (findings.length === 0) {
    process.stdout.write("\nno problems found\n");
    return 0;
  }

  process.stdout.write("\n");
  for (const finding of findings) {
    process.stdout.write(`${finding.severity}: [${finding.code}] ${finding.message}\n`);
  }
  return findings.some((f) => f.severity === "error") ? 1 : 0;
}

// Only run when invoked as a program, so tests can import `main` freely.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      process.stderr.write(`atmo: ${(e as Error).stack ?? String(e)}\n`);
      process.exit(70);
    });
}
