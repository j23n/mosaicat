# 004: Ship atmo as a Bun-compiled binary

- **Status:** live
- **Date:** 2026-08-05
- **Supersedes:** — <!-- amends the map row "TypeScript, not Go — despite Hugo's single-binary appeal" -->

## Context

npm is a poor ship vehicle for a CLI that authors should install once and
forget: global installs fight Node version managers, and "clone the repo and
`npm ci`" is contributor workflow, not product distribution. The course chose
TypeScript over Go because CLI encrypt and browser decrypt share
`age-encryption` — that rationale still holds. Alternatives actually
considered after a packaging spike: rewrite in Go/Rust for a small static
binary (throws away the shared crypto stack and ~4k LOC of working TS); Node
SEA (~118 MB on Node 22, templates need a separate asset API and code
changes); Deno compile (larger in practice here, and an esbuild single-file
bundle hit dynamic-`require` failures in `sanitize-html`/postcss); and Bun
`build --compile` (~74 MB with templates embedded via `--asset`).

## Decision

Keep TypeScript as the implementation language. Distribute **atmo** to end
users as a **Bun-compiled single binary**, with bundled default templates:

- **Pack with `scripts/pack.sh` / `npm run pack`.** Compile `src/cli.ts` from
  `src/` with `bun build --compile --asset ./templates` so
  `BUILTIN_TEMPLATES` (`dirname(import.meta.url)/templates`) resolves inside
  `/$bunfs/`. Cross-compile via `--target bun-<os>-<arch>`.
- **Bun canary until `--asset` is in a stable release.** Directory embedding
  landed in Bun 1.4 canary; CI pins `bun-version: canary` and the pack script
  refuses Bun builds that lack `--asset`. Revisit the pin when stable ships
  the flag.
- **`copyFile` fallback for template assets.** Bun's `$bunfs` supports
  `readFile`/`stat` but `fs.cp` fails on `lstat`. `src/copy-file.ts` tries
  `cp` then read+write; `build` uses it for CSS/JS copied out of the template
  tree. Blob copies from the on-disk cache keep using `cp`.
- **Release matrix on `v*` tags.** `.github/workflows/release.yml` builds on
  **native** runners (linux x64/arm64, darwin x64/arm64, windows x64), smokes
  `--help`/`--version` on each, and attaches artifacts to the GitHub Release.
  Native runners (not Bun `--target` cross-compile) while CI pins canary —
  canary often lacks downloadable cross-compile runtimes.
  `scripts/pack.sh --target` remains for local use once a Bun release
  publishes those targets. PRs get a lighter pack smoke
  (`.github/workflows/pack.yml`).
- **npm stays the contributor path.** `npm run atmo`, tests, and `tsc` are
  unchanged. The npm package is not removed, but binary releases are the
  intended install for operators.

## Consequences

Operators get a single file (~60–100 MB class; ~74 MB measured on linux
aarch64 in the spike) with no Node/npm on the target. Template overrides in
the project `templates/` directory still win over builtins. Costs: release
CI depends on Bun canary until `--asset` stabilizes; five native runners are
slower/costlier than one cross-compile job; binary size is dominated by the
Bun runtime, not atmo's LOC; a Go/Rust port remains available if a hard size
budget appears, but that would be a new ADR and would reopen the
shared-crypto question. Homebrew and other secondary installers can wrap the
GitHub Release artifacts later without changing this decision.
