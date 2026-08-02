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
import { pull } from "./pull.js";

const USAGE = `atmo — a static site generator for an ATProto repo

usage:
  atmo pull    [--config <path>]   fetch records and blobs into the cache
  atmo build   [--config <path>]   render the cache into the output directory
  atmo doctor  [--config <path>]   check config and report what would be fetched

options:
  -c, --config <path>   config file (default: atmo.toml)
  -h, --help            show this help
  -V, --version         show version
`;

const VERSION = "0.0.0";

type Command = "pull" | "build" | "doctor";

const COMMANDS = new Set<Command>(["pull", "build", "doctor"]);

function isCommand(value: string): value is Command {
  return COMMANDS.has(value as Command);
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", short: "c", default: "atmo.toml" },
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

  try {
    const config = await loadConfig(values.config);

    switch (command) {
      case "doctor":
        return doctor(config);
      case "pull": {
        const results = await pull(config, { log: (l) => process.stdout.write(`${l}\n`) });
        const total = results.reduce((n, r) => n + r.records, 0);
        process.stdout.write(`\npulled ${total} record(s) into ${config.cache_dir}\n`);
        return 0;
      }
      case "build":
        // Implemented in learn/d-emit-a-site.
        process.stderr.write(`atmo: "build" is not implemented yet\n`);
        return 1;
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
    throw e;
  }
}

function doctor(config: Awaited<ReturnType<typeof loadConfig>>): number {
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
  return 0;
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
