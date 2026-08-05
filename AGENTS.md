# AGENTS.md

Guidance for coding agents (and humans) working on this repo.

**What this is:** atmo — a TypeScript static site generator for an ATProto
repo. Two-phase pipeline: `pull` is the only command that touches the network
(records + blobs → `.atmo/cache`); `build` renders the cache into `dist/`
deterministically — no network, no ambient clock. ESM throughout, Node ≥ 20,
no framework.

## Commands

```bash
npm ci                          # install (what CI uses)
npm run atmo -- <cmd>           # run the CLI from source; the -- is REQUIRED
                                #   subcommands: init <handle> | pull | build | doctor
                                #   | publish | unpublish
npm test                        # vitest run (pretest bundles the client decrypt script)
npx vitest run tests/guard.test.ts   # a single test file — skips that pretest bundle;
                                #   if private/crypto tests miss decrypt.js, `npm run bundle` once
npm run typecheck               # TWO tsconfigs (main + client); both must pass
npm run lint                    # prettier --check only — it also checks .md files,
                                #   so run `npx prettier --write` on anything you touch
npm run pack                    # Bun --compile binary into dist-bin/ (needs Bun with --asset;
                                #   canary ≥ 1.4 today — see ADR 004)
```

CI (`.github/workflows/ci.yml`) runs typecheck + lint + test on Node 20 and 22.
Pack smoke (`.github/workflows/pack.yml`) compiles a native binary on PRs.
Release tags `v*` build binaries on a native OS matrix
(`.github/workflows/release.yml`). Green CI is the merge bar.

## Where truth lives

- [docs/decisions/map.md](docs/decisions/map.md) — **live status of every
  design decision.** Check the relevant rows before changing behavior.
- [docs/decisions/](docs/decisions/) — ADRs for decisions made after the
  course; the process is in its README.
- [docs/learning/](docs/learning/) — lessons `a`–`k`, the deep rationale.
  **Frozen: never edit these files.** Lesson k deliberately corrects earlier
  lessons without touching them; the map records what superseded what.
- Module header comments in `src/*.ts` — each file opens with its design
  posture. Read the header before editing the file.

Conflict rule: the map wins on _status_, lessons/ADRs win on _rationale_,
code wins on _behavior_.

## Development process

- Branch from `main`, open a normal PR, CI green. The maintainer reviews and
  merges. No new `learn/*` branches — the course is a finished artifact.
- When the maintainer and you take a **real decision** together (alternatives
  with lasting consequences — see
  [docs/decisions/README.md](docs/decisions/README.md)), record it as an ADR
  **and** add or update its row in `map.md` in the same PR. Trivial choices
  (naming, mechanical refactors) don't qualify.
- Correcting a course-era decision means: new ADR, flip the map row to
  superseded, leave the lesson untouched.

## Conventions you won't find written anywhere else

**TypeScript strictness** (all deliberate; don't relax the config):

- Relative imports need `.js` suffixes (`import { x } from "./config.js"`).
- `verbatimModuleSyntax`: type-only imports must use `import type`.
- `noUncheckedIndexedAccess`: indexing returns `T | undefined`; tests use
  `arr[0]!`, source prefers narrowing.
- `exactOptionalPropertyTypes`: never pass `key: undefined` — use conditional
  spreads: `...(x !== undefined ? { key: x } : {})`.

**Style:** prettier only (semicolons, printWidth 100). There is no ESLint;
don't add one.

**Dependency injection:** side effects (`fetch`, DNS lookup, `now`, `log`)
are injected as options parameters, never imported ambiently. `main()`
returns an exit code and never calls `process.exit` — tests assert on the
return value.

**Exit codes:** 0 ok · 1 usage · 2 bad config · 3 network · 4 build refused ·
5 missing passphrase · 70 internal error. All mapped in the single `catch` in
`src/cli.ts`; a new failure mode must claim its code there.

**Two opposite parsing postures, both deliberate:**

- Records are hostile input: parse tolerantly, skip what's unusable, **no
  record shape may throw** (`src/document.ts`, `src/leaflet.ts`).
- Config is strict: zod-validated, bad config fails at load with exit 2
  (`src/config.ts`).
  Don't "fix" either to match the other.

**Tests:** flat `tests/*.test.ts`, one file per module. The build/guard idiom
is: `mkdtemp` a project dir → `writeSourceCache(...)` → `parseConfig(...)` →
`loadSite`/`build` → assert on files or the model. Copy the shape from
`tests/build.test.ts`. `tests/fake-pds.ts` (`fakeNetwork`) is for pull-side
tests only — everything downstream tests from the cache, not the network.
Nothing in the suite opens a socket.

**Templates:** two-root resolution — project `templates/` first, bundled
`src/templates/` second; overriding one file changes nothing else. A
collection template registers by filename (`templates/collections/<nsid>.eta`);
there is no registry code to edit. Eta partials do **not** resolve through the
override chain — shared markup goes inline in `base.eta` via `PageContext`.

**Guards:** `build` refuses (exit 4) when the site looks wrong — empty, or
shrunk ≥ 50% vs the last manifest (`SHRINK_THRESHOLD`, `src/guard.ts`).
`--force` is the escape hatch, deliberately a flag and not config.

## Read this before touching X

| Area                              | Module header                                              | Lesson | Map section             |
| --------------------------------- | ---------------------------------------------------------- | ------ | ----------------------- |
| Config / CLI surface              | `src/config.ts`, `src/cli.ts`                              | a      | Language & tooling      |
| Identity, fetching, SSRF          | `src/http.ts`, `src/identity.ts`, `src/repo.ts`            | b      | Network & pull          |
| Record parsing / document model   | `src/document.ts`                                          | c, k   | Records & parsing       |
| Leaflet-native rendering          | `src/leaflet.ts`                                           | k      | Field-test corrections  |
| Site model / emission / templates | `src/site.ts`, `src/build.ts`, `src/render.ts`             | d      | Rendering & site model  |
| Feeds / sitemap / robots          | `src/feed.ts`                                              | d, f   | Rendering & site model  |
| Blobs / images                    | `src/blob.ts`                                              | e, k   | Blobs                   |
| Arbitrary collections             | `src/collection.ts`                                        | f, k   | Collections & templates |
| Client-side reactions             | `src/templates/reactions.js`                               | g      | Reactions               |
| Cache, guards, doctor, exit codes | `src/guard.ts`, `src/cache.ts`                             | h      | Build integrity         |
| Private posts / crypto            | `src/crypto.ts`, `src/private.ts`, `src/client/decrypt.ts` | i      | Private & crypto        |
| init / packaging                  | `src/init.ts`, `scripts/pack.sh`, `src/copy-file.ts`       | j, 004 | Packaging & docs        |

## Doc hygiene

- `docs/learning/**` is append-only history — never edit.
- `README.md` and `docs/deploy.md` are user-facing; keep internal process out
  of them.
- A new **convention** belongs in this file; a new **decision** belongs in an
  ADR plus its map row.
