# h — Builds you can trust

> **Stack:** h/j · **base:** `learn/g-reactions-in-browser`
> **Diff:** `learn/g-reactions-in-browser...learn/h-builds-you-can-trust` ·
> **What it adds:** guards that refuse to publish a bad build, a manifest
> recording what the last good one produced, `--force` for when you mean it,
> and a real `atmo doctor`.

## The one-sentence version

A server that degrades badly self-heals on the next request; a static build
does not — so the checks move _before_ the write, into the moment branch `d`
created where the whole site model exists and nothing has been emitted.

## Learning objectives

**Craft**

- Why a static generator's failure modes are **less** forgiving than a
  server's, and what follows from that.
- Comparing a build against the last good one, and picking a threshold you can
  defend.
- The **error vs warning** distinction: can a human plausibly _want_ this?
- `--force` as the escape hatch that makes strict defaults acceptable.
- Making the cost of a tolerant parser visible without making it fatal.

**ATProto**

- PDS availability as an ordinary operating condition rather than an
  exception.

## Grounding: official docs

- Node `process.exitCode` conventions —
  <https://nodejs.org/api/process.html#process_exit_codes>
- `--check` style CI gates, e.g. Django's `makemigrations --check`, as the
  genre this belongs to

## Background: the failure mode that inverted

Every earlier branch has been relentlessly forgiving. A malformed record is
skipped (`c`). A blob that won't download stays remote (`e`). A collection with
no template renders generically (`f`). An AppView outage means a smaller
section (`g`).

That posture is right, and it has a blind spot.

Consider a server-rendered version of this site. The PDS times out; the page
renders with no posts; the reader sees an empty site. **The next request tries
again**, and when the PDS recovers, so does the site. The bad state is
transient and self-correcting.

Now the static version. The PDS times out during `pull`; the cache ends up
nearly empty; `build` renders a site with no posts and **succeeds**; you deploy
it. That empty site is what the world sees — not for a second, but until a
human notices and re-runs the build. Nothing will notice, because from the
tooling's perspective everything worked.

```
server:  bad input → bad response → next request is fine        (self-healing)
static:  bad input → bad output   → deployed → stays bad        (persistent)
```

So the same tolerance that is correct _within_ a build becomes dangerous _at
the boundary of_ a build. The resolution: keep degrading at the field level,
and add a gate at the point where the whole picture is visible.

Branch `d` built that point deliberately. `loadSite` produces the entire model
before `build` writes a byte. This branch puts the checks there.

## Guided tour of the diff (read in this order)

1. **`src/guard.ts`** — `inspect` is the whole policy in one function. Read the
   errors first, then the warnings, and note that everything under `if (!force)`
   is a judgement about _plausibility_, not correctness.

2. **`src/build.ts`** — three added lines that matter: read the manifest,
   inspect, throw _before_ `rm(out_dir)`. The ordering is the feature.

3. **`src/site.ts`** — `skipped` counts records that parsed to nothing, which
   is branch `c`'s silent cost finally being measured.

4. **`src/cli.ts`** — `doctor` now loads the model and reports; exit code `4`
   is a refused build, distinct from `2` (bad config) and `3` (network).

5. **`tests/guard.test.ts`** — read "refuses a collapsed build and leaves the
   previous output intact". That assertion _is_ the branch.

## Deep dive: refuse before you delete

```ts
const site = await loadSite(config);

const previous = await readManifest(config.cache_dir);
const findings = inspect(site, { force, previous });
if (hasErrors(findings)) throw new GuardError(findings);

await rm(config.out_dir, { recursive: true, force: true });
```

The `rm` from branch `d` is what makes ordering critical. If inspection ran
after it — or worse, during emission — a refused build would have _already
deleted the previous site_. You'd trade "published something bad" for
"published nothing", which is not an improvement.

Placed first, a refusal leaves `dist/` exactly as it was. If your deploy step
uploads `dist/`, a failed build means the last good site stays up. There is a
test that reads a file before and after a refused build and asserts the bytes
are identical.

The same reasoning applies to the manifest: it is written only after a
successful build, so a refused build cannot poison the baseline that future
comparisons use.

## Deep dive: how much loss is a bug?

```ts
const lost = previous.pages - site.pages.length;
if (lost > 0 && lost / previous.pages >= SHRINK_THRESHOLD) { … }
```

Any threshold is arbitrary; the job is to pick one you can argue for. 50% says:
_deleting more than half your posts in one go is more likely to be a broken
pull than an editorial decision._

Why a proportion rather than a count? A site with 4 posts losing 2 is a big
deal; a site with 400 losing 2 is Tuesday. Absolute counts need tuning per
site; a proportion doesn't.

Three details worth noticing:

- **`lost > 0`** means growth never trips it. Obvious, and worth a test,
  because `Math.abs` is exactly the kind of thing someone adds while
  "cleaning up".
- **`previous.pages > 0`** means the first build is never compared. There is no
  baseline, and comparing against zero would either always or never fire.
- The message names the fix (`atmo pull`) _and_ the override (`--force`).

The `empty-site` check is the degenerate case: zero pages **and** zero
collections. Both, because a site that is only book lists is legitimate.

`missing-source` is an error rather than a warning, and it's the one most
likely to fire in practice — it means `pull` never ran for that source, so a
whole section would silently vanish. Branch `d` recorded it and warned; this
branch upgrades it, because "silently missing" is precisely what this module
exists to prevent.

## Deep dive: error, warning, or nothing

The test for whether something is an error is not "is it wrong" but **"could a
human plausibly want this outcome?"**

| Finding           | Severity | Could you want it?                                      |
| ----------------- | -------- | ------------------------------------------------------- |
| `missing-source`  | error    | No — a configured source with no data is never intended |
| `empty-site`      | error    | Practically never, and `--force` covers the exception   |
| `shrink`          | error    | Sometimes — hence `--force`                             |
| `skipped-records` | warning  | Maybe; a broken record isn't your fault                 |
| `untitled`        | warning  | Yes — an untitled note is a real thing                  |

`skipped-records` is the interesting one. Branch `c` deliberately drops
unrenderable records with no user-visible signal, and I said then that the cost
would be paid here. This is the payment: `doctor` and every build now report
how many records didn't make it. Not fatal — a malformed record written by
someone else's tool shouldn't stop your site — but no longer invisible.

**Silence is a design choice, and choosing it obliges you to provide a way to
break it.**

## Design decisions & "why not X"

- **Why compare against a manifest rather than the previous `dist/`?** The
  output may not exist (fresh clone, CI cache miss), and counting HTML files
  would conflate pages with assets. A tiny JSON file with the numbers that
  matter is cheaper and more honest.
- **Why store the manifest in the cache directory rather than `dist/`?**
  `dist/` is deleted on every build. Putting the baseline there would mean it
  never survives to be compared against.
- **Why `--force` instead of a config option?** A config option is set once and
  forgotten, which turns the guard off permanently. A flag is a per-invocation
  decision by someone who just read the error.
- **Why is `doctor` a separate command rather than `build --dry-run`?**
  `doctor` reports _everything_, including warnings that don't affect the exit
  code, and it never touches `dist/`. It's a diagnostic, not a rehearsal.
- **Why distinct exit codes (2 config, 3 network, 4 refused)?** So a CI script
  can tell "your config is broken" from "the PDS was down" from "the build
  looked wrong" without parsing text.
- **Why not auto-retry the pull on a shrink?** Because `build` has no network,
  by design since branch `a`. Retrying is `pull`'s job, and conflating them
  would undo the property that makes this check possible.

## Review questions

1. _Why must `inspect` run before `rm(out_dir)`?_ — Otherwise a refused build
   has already destroyed the previous site, converting "published something
   bad" into "published nothing".
2. _Why is `shrink` an error but `untitled` a warning?_ — Losing half your
   posts is almost never intended, and when it is, `--force` says so. An
   untitled post is a legitimate thing to publish.
3. _Branch `c` skips unrenderable records silently. Is that still true?_ — At
   the parse level, yes, and it should be. But the count now surfaces as a
   warning in every build and in `doctor`, so the silence is scoped to the
   layer that has no way to report.

## Exercises

1. **Trip the guard.** Build a site, then hand-edit the cache to remove most
   records and build again. Read the error. Confirm `dist/` is untouched.
   Re-run with `--force`.
2. **Defend the threshold.** Argue for 25% and for 80%. Which sites does each
   protect, and which does it annoy? Change `SHRINK_THRESHOLD` and see which
   tests move.
3. **Add a check.** Warn when two documents produce the same slug — they
   currently overwrite each other silently. Error or warning? Justify it with
   the table above.
4. **Make it CI-shaped.** Write a script that runs `pull`, then `doctor`, and
   fails the job on exit code 1. What should it do about warnings?

## Verify it yourself

```bash
npm test -- guard
npm run atmo -- doctor            # counts, last build, findings
npm run atmo -- build             # refuses if something looks wrong
npm run atmo -- build --force     # publishes anyway
```

## Watch & listen

- Nothing ATProto-specific this round. The relevant reading is your own deploy
  pipeline: find the step that uploads `dist/` and confirm it cannot run when
  the build exits non-zero. That single check is worth more than this entire
  module if the pipeline gets it wrong.

## Glossary

- **Build manifest** — a record of what the last successful build produced,
  used as the baseline for comparison.
- **Shrink guard** — refusal when the page count collapses versus that
  baseline.
- **Error vs warning** — whether a human could plausibly want the outcome.
- **`--force`** — a per-invocation override, chosen over a config flag so it
  can't be permanently forgotten.
- **Skipped record** — one branch `c` could not render; counted here, never
  fatal.
