# a — The skeleton

> **Stack:** a/j · **base:** `main` (an empty repository)
> **Diff:** `main...learn/a-skeleton` · **What it adds:** a TypeScript project,
> a `atmo` CLI with three subcommands, a validated TOML config, a test suite,
> and CI. One of those three subcommands actually works.

## The one-sentence version

Before any network code exists, the tool already has the two things that shape
everything after it: **a config file that is the entire public surface**, and a
**command split that keeps the network on one side of a wall** — `pull`
fetches, `build` renders, and neither can break the other.

## Learning objectives

**Craft**

- Designing a config surface as one file with one loader, so nothing
  downstream reads ambient state.
- **Failing at load, not at runtime** — encoding "either a handle, or _both_ a
  DID and a PDS URL" as a schema rule rather than a fetch-time surprise.
- Schema-first validation with **zod**: defaults, transforms, refinements, and
  error messages that name the offending path.
- A CLI on Node's built-in `parseArgs` — no framework, no dependency.
- Exit codes as an interface: `0` fine, `1` usage, `2` bad config.
- `strict` TypeScript with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`, and why those two in particular.

**ATProto** _(none yet — read the primer instead)_

- The [primer in the syllabus](README.md#a-10-minute-atproto-primer-read-once-before-b)
  is the prerequisite for branch `b`. This lesson touches no network.

## Grounding: official docs

- Node `util.parseArgs` —
  <https://nodejs.org/api/util.html#utilparseargsconfig>
- zod — <https://zod.dev/>
- TOML v1.0 — <https://toml.io/en/v1.0.0>
- `tsconfig` reference — <https://www.typescriptlang.org/tsconfig>
- Vitest — <https://vitest.dev/>
- `standard.site` lexicons (what we'll be reading from `b` onward) —
  <https://standard.site/>

## Background: two decisions made before any features

**1. One config file, one loader.**

`atmo` renders a site from repos. Nearly every later stage needs to know _which
repos_, _which collections_, and _where output goes_. The tempting shape is for
each module to reach for what it needs — an env var here, a default there.
Don't. `src/config.ts` parses and validates once, and every other module takes
the resulting object as an argument.

The payoff shows up in `i-private-by-capability`, where a private repo is just
another `[[source]]` entry with two extra fields. No new plumbing, because
there was only ever one place to add it.

**2. `pull` and `build` are separate commands.**

This looks like ceremony now and is the most consequential decision in the
project:

```
atmo pull    network → cache        the only thing that touches the network
atmo build   cache   → dist/        the only thing that writes output
```

A generator that fetches _and_ renders in one pass couples two failure modes
that have nothing to do with each other. A slow PDS becomes a broken site.
Template iteration re-hits the network. CI can't cache anything useful.

Split them and: `build` is a pure function of the cache and can't fail from
anything remote; `atmo dev` re-renders instantly; CI caches the pull; and
`h-builds-you-can-trust` gets somewhere to put a guard that refuses to publish
a suspiciously empty result. None of that is available if the two are one step.

## Guided tour of the diff (read in this order)

1. **`atmo.example.toml`** — read the config _before_ the code that parses it.
   Note the commented-out private source: `did` and `pds_url` given verbatim,
   with a comment about where such a build must run.

2. **`src/config.ts`** — the schema. Read `SourceSchema` top to bottom, then
   the `.refine()` beneath it, which is the deep dive below. Note that
   `base_url` is _transformed_ (trailing slash stripped) rather than merely
   validated, so no downstream join ever produces `//`. Note also that
   `parseConfig` takes a **string**, not a path: the parsing logic is testable
   without touching the filesystem, and `loadConfig` is the thin wrapper that
   does I/O.

3. **`src/cli.ts`** — `parseArgs`, a `Command` union narrowed by
   `isCommand()`, and `doctor` as the only implemented verb. `main()` returns
   an exit code rather than calling `process.exit`, so tests can drive it.
   `pull` and `build` deliberately exit non-zero with "not implemented yet"
   instead of silently doing nothing.

4. **`tests/config.test.ts`** — read the `it.each` block first. It is the
   specification for the rule that matters.

5. **`tsconfig.json` / `.github/workflows/ci.yml`** — strict settings and a
   Node 20 × 22 matrix.

## Deep dive: making a half-configured identity impossible

A source can name its repo two ways:

```toml
handle = "you.example.com"          # resolved: handle -> DID -> PDS
```

```toml
did     = "did:plc:abc…"            # used verbatim, no resolution
pds_url = "http://pds-private:3000"
```

The second form exists because **you cannot resolve a handle that has no public
DNS record.** A private PDS on an internal network has no resolvable handle, so
its identity has to be supplied directly. That's what makes branch `i` possible
at all.

Now the interesting part — the rule beneath the schema:

```ts
.refine(
  (s) => s.handle !== undefined || (s.did !== undefined && s.pds_url !== undefined),
  { message: "a source needs either `handle`, or both `did` and `pds_url` …" },
)
```

Consider what `did` _without_ `pds_url` would mean. You have an identity but no
address. Nothing catches it at load; the config looks fine; `atmo doctor`
prints happily. Then during a pull, some code path needs an endpoint, finds
`undefined`, and either throws deep in a fetch or — worse — silently falls back
to a default PDS and quietly renders **the wrong repo**.

The refinement collapses that whole class of bug into a message at startup.
The general rule: **when two fields are only meaningful together, make the
schema say so.** An optional field that is secretly required-with-another is a
runtime failure waiting for the least convenient moment.

Two details worth stealing:

- The error message says _why_, not just _what_. "A half-configured identity
  would fail at fetch time instead of never existing" tells the reader which
  bug the rule prevents.
- The test uses `it.each` over both half-configurations. Testing only `did`
  alone would leave the mirror case unprotected, and it is exactly as wrong.

## Design decisions & "why not X"

- **Why TypeScript rather than Go, given Hugo's single binary?** Because branch
  `i` encrypts at build time and decrypts _in a browser_. In Go you would write
  the encryptor in one language and the decryptor in another, and they must
  agree on a byte format — which is precisely where people invent crypto bugs.
  One language means one library and no format to specify. Ecosystem fit
  (`@atproto/api`) and npm distribution are secondary.
- **Why TOML, not JSON or YAML?** Config is written by hand and wants comments,
  which JSON lacks. YAML's implicit typing is a well-known footgun. TOML's
  array-of-tables syntax also happens to express repeated `[[source]]` blocks
  more clearly than either.
- **Why zod rather than hand-written validation?** Defaults, transforms and
  the refinement above are all declarative and colocated with the type, and
  `z.infer` means the parsed type can't drift from the schema. Hand-rolled
  checks drift the first time someone adds a field.
- **Why `parseArgs` instead of commander or yargs?** Three subcommands and two
  flags. It's in the standard library and it does the job. Reach for a CLI
  framework when subcommand composition actually hurts.
- **Why does `doctor` exist this early?** It's the only way to observe the
  config layer, which makes it the natural home for the first test of "does
  this thing work at all." It grows real checks in `h`.
- **Why `noUncheckedIndexedAccess`?** `config.source[0]` is `Source |
undefined` under this flag, which forces you to acknowledge that an array
  index might miss. It's noisy in tests (`config.source[0]!`) and it will catch
  a real bug the first time a collection comes back empty.

## Review questions

1. _Why does `parseConfig` take a string while `loadConfig` takes a path?_ —
   So the parsing and validation logic — all the interesting behaviour — is
   testable with no filesystem, no fixtures, and no cleanup. The I/O wrapper is
   four lines and needs one test, not nine.
2. _`main()` returns a number instead of calling `process.exit`. Why?_ — Tests
   can call `main(["doctor"])` and assert on the exit code. A function that
   kills the process can only be tested by spawning one.
3. _What breaks if `base_url` is validated but not transformed?_ — Every URL
   join downstream has to defend against a trailing slash, forever, in every
   call site. Normalising once at the boundary means the rest of the codebase
   can assume the clean form. Boundaries are where you fix shapes.

## Exercises

1. **Add a field.** Give `[site]` an optional `language` defaulting to `"en"`.
   Notice that you touch exactly one file and get the type for free.
2. **Break the rule on purpose.** Delete the `.refine()` and run the suite.
   Which tests fail, and what would the failure have looked like at fetch time
   instead?
3. **Extend `doctor`.** Make it exit `1` and print a warning when two sources
   name the same `handle` _and_ the same `publication` — they'd render
   identical content to two places. Is that better as a `doctor` warning or a
   schema error? Argue both.
4. **Exit codes.** Write a test that drives `main()` directly and asserts `2`
   for an invalid config and `1` for an unknown command.

## Verify it yourself

```bash
npm ci
npm run typecheck
npm test

cp atmo.example.toml atmo.toml
npm run atmo -- doctor            # prints the parsed config
npm run atmo -- pull              # exits 1: not implemented until branch b
```

## Watch & listen

- **Before branch `b`**, listen to
  [SE Radio 651 with Paul Frazee](https://se-radio.net/2025/01/se-radio-651-paul-frazee-on-bluesky-and-the-at-protocol/)
  and read [mackuba's Introduction to AT Protocol](https://mackuba.eu/2025/08/20/introduction-to-atproto/).
  Everything from here on assumes the PDS/repo/record model.
- **Go and look at a real repo now** — open [pdsls.dev](https://pdsls.dev),
  type any handle, and find a `site.standard.document`. Branch `b` fetches
  exactly what you're looking at.

## Glossary

- **Source** — one configured repo + which collections to read from it.
- **Publication** — a `site.standard.publication` record; documents name theirs
  in a `site` field, which is how one repo holds several publications.
- **Refinement** — a zod rule spanning several fields, checked after their
  individual types pass.
- **`pull` / `build` split** — the wall between the only command that uses the
  network and the only command that writes output.
