# Decision map

Every design decision the project has taken, its current status, and where
the full rationale lives. Course-era rows link into [the lessons](../learning/);
post-course rows link to ADRs in this directory. Check a row's status **before**
changing the behavior it covers.

Maintained by hand: every PR that adds an ADR adds or updates its row here —
same PR, no exceptions (see [README.md](README.md)).

Statuses: `live` (current truth) · `superseded — k` (corrected by
[lesson k](../learning/k-field-report.md), the field report).

### Language & tooling

| Decision                                                                                  | Status | Rationale                                                                                    | Code                                        |
| ----------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- | ------------------------------------------- |
| TypeScript, not Go — despite Hugo's single-binary appeal                                  | live   | [a §decisions](../learning/a-skeleton.md#design-decisions--why-not-x)                        | repo-wide                                   |
| TOML for config, not JSON or YAML                                                         | live   | [a §decisions](../learning/a-skeleton.md#design-decisions--why-not-x)                        | `src/config.ts`                             |
| zod for config validation, not hand-written checks                                        | live   | [a §decisions](../learning/a-skeleton.md#design-decisions--why-not-x)                        | `src/config.ts`                             |
| `node:util` `parseArgs`, not commander/yargs                                              | live   | [a §decisions](../learning/a-skeleton.md#design-decisions--why-not-x)                        | `src/cli.ts`                                |
| `doctor` exists from the first branch                                                     | live   | [a §decisions](../learning/a-skeleton.md#design-decisions--why-not-x)                        | `src/cli.ts`                                |
| `noUncheckedIndexedAccess` (and friends) on                                               | live   | [a §decisions](../learning/a-skeleton.md#design-decisions--why-not-x)                        | `tsconfig.json`                             |
| One config loader; modules take the parsed object, no ambient state                       | live   | [a §background](../learning/a-skeleton.md#background-two-decisions-made-before-any-features) | `src/config.ts`                             |
| `pull` and `build` are separate commands — the most consequential decision in the project | live   | [a §background](../learning/a-skeleton.md#background-two-decisions-made-before-any-features) | `src/cli.ts`, `src/pull.ts`, `src/build.ts` |

### Network & pull

| Decision                                                    | Status | Rationale                                                                | Code                               |
| ----------------------------------------------------------- | ------ | ------------------------------------------------------------------------ | ---------------------------------- |
| Hand-rolled identity resolution, no `@atproto/api`          | live   | [b §decisions](../learning/b-read-a-repo.md#design-decisions--why-not-x) | `src/identity.ts`                  |
| Cache stores raw records, never parsed ones                 | live   | [b §decisions](../learning/b-read-a-repo.md#design-decisions--why-not-x) | `src/cache.ts`                     |
| One failing source aborts the whole pull                    | live   | [b §decisions](../learning/b-read-a-repo.md#design-decisions--why-not-x) | `src/pull.ts`                      |
| `reverse=true` on record walks; display order decided later | live   | [b §decisions](../learning/b-read-a-repo.md#design-decisions--why-not-x) | `src/repo.ts`                      |
| `fetch` and DNS are injected, never module-mocked           | live   | [b §decisions](../learning/b-read-a-repo.md#design-decisions--why-not-x) | `src/http.ts`, `tests/fake-pds.ts` |

### Records & parsing

| Decision                                                 | Status         | Rationale                                                                        | Code                                |
| -------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------- | ----------------------------------- |
| Records are not zod-validated — tolerant probing instead | live           | [c §decisions](../learning/c-records-are-hostile.md#design-decisions--why-not-x) | `src/document.ts`                   |
| Unusable record → `null`, never throw-and-catch          | live           | [c §decisions](../learning/c-records-are-hostile.md#design-decisions--why-not-x) | `src/document.ts`                   |
| `rkey` derived from the URI; `slug` from a record field  | live           | [c §decisions](../learning/c-records-are-hostile.md#design-decisions--why-not-x) | `src/document.ts`                   |
| `content` probed rather than typed (open union)          | live           | [c §decisions](../learning/c-records-are-hostile.md#design-decisions--why-not-x) | `src/document.ts`, `src/leaflet.ts` |
| `slugify` capped at 80 characters                        | live           | [c §decisions](../learning/c-records-are-hostile.md#design-decisions--why-not-x) | `src/document.ts`                   |
| `publication = "self"` as the default filter             | superseded — k | [k §decisions](../learning/k-field-report.md#design-decisions--why-not-x)        | `src/config.ts`                     |
| `textContent` treated as an always-present fallback      | superseded — k | [k §decisions](../learning/k-field-report.md#design-decisions--why-not-x)        | `src/document.ts`                   |

### Rendering & site model

| Decision                                                | Status | Rationale                                                                | Code                             |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------------------ | -------------------------------- |
| Eta templates, not Handlebars/Nunjucks/JSX              | live   | [d §decisions](../learning/d-emit-a-site.md#design-decisions--why-not-x) | `src/render.ts`                  |
| Sanitize at build; never trust the author's HTML        | live   | [d §decisions](../learning/d-emit-a-site.md#design-decisions--why-not-x) | `src/markdown.ts`                |
| Feed carries summaries, not full content                | live   | [d §decisions](../learning/d-emit-a-site.md#design-decisions--why-not-x) | `src/feed.ts`                    |
| `robots.txt` disallows `/p/` before private posts exist | live   | [d §decisions](../learning/d-emit-a-site.md#design-decisions--why-not-x) | `src/feed.ts`                    |
| Tag pages don't paginate                                | live   | [d §decisions](../learning/d-emit-a-site.md#design-decisions--why-not-x) | `src/site.ts`                    |
| Missing summaries derived from an excerpt               | live   | [d §decisions](../learning/d-emit-a-site.md#design-decisions--why-not-x) | `src/site.ts`, `src/markdown.ts` |

### Blobs

| Decision                                                 | Status         | Rationale                                                                    | Code                                    |
| -------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| Blobs download during `pull`, never `build`              | live           | [e §decisions](../learning/e-blobs-as-assets.md#design-decisions--why-not-x) | `src/pull.ts`, `src/blob.ts`            |
| Blobs stored as `<cid>.<ext>`, not original filenames    | live           | [e §decisions](../learning/e-blobs-as-assets.md#design-decisions--why-not-x) | `src/blob.ts`                           |
| Documents parsed twice — once in `pull`, once in `build` | live           | [e §decisions](../learning/e-blobs-as-assets.md#design-decisions--why-not-x) | `src/pull.ts`, `src/site.ts`            |
| No image resizing or re-encoding                         | live           | [e §decisions](../learning/e-blobs-as-assets.md#design-decisions--why-not-x) | `src/blob.ts`                           |
| `loading="lazy"` forced onto every `<img>`               | live           | [e §decisions](../learning/e-blobs-as-assets.md#design-decisions--why-not-x) | `src/markdown.ts`                       |
| Cover images fetched but never rendered                  | superseded — k | [k §decisions](../learning/k-field-report.md#design-decisions--why-not-x)    | `src/site.ts`, `src/templates/post.eta` |

### Collections & templates

| Decision                                         | Status         | Rationale                                                                     | Code                          |
| ------------------------------------------------ | -------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| A BookHive template ships with the tool          | live           | [f §decisions](../learning/f-personal-appview.md#design-decisions--why-not-x) | `src/templates/collections/`  |
| No lexicon-schema fetching or template codegen   | live           | [f §decisions](../learning/f-personal-appview.md#design-decisions--why-not-x) | `src/collection.ts`           |
| Encrypted sources excluded from collection pages | live           | [f §decisions](../learning/f-personal-appview.md#design-decisions--why-not-x) | `src/site.ts`                 |
| Collection pages don't paginate                  | live           | [f §decisions](../learning/f-personal-appview.md#design-decisions--why-not-x) | `src/collection.ts`           |
| Collection pages emitted but linked from nowhere | superseded — k | [k §decisions](../learning/k-field-report.md#design-decisions--why-not-x)     | `src/build.ts`, `src/feed.ts` |

### Reactions

| Decision                                                 | Status | Rationale                                                                                                           | Code                         |
| -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Reactions are client-side — the build never touches them | live   | [g §the decision that matters](../learning/g-reactions-in-browser.md#the-decision-that-matters-this-is-client-side) | `src/templates/reactions.js` |
| Mount point ships `hidden` until data arrives            | live   | [g §decisions](../learning/g-reactions-in-browser.md#design-decisions--why-not-x)                                   | `src/templates/post.eta`     |
| `defer` on the reactions script                          | live   | [g §decisions](../learning/g-reactions-in-browser.md#design-decisions--why-not-x)                                   | `src/templates/post.eta`     |
| AppView/Constellation endpoints are configurable         | live   | [g §decisions](../learning/g-reactions-in-browser.md#design-decisions--why-not-x)                                   | `src/config.ts`              |
| Plain ES5-flavoured JS, no build step                    | live   | [g §decisions](../learning/g-reactions-in-browser.md#design-decisions--why-not-x)                                   | `src/templates/reactions.js` |
| No server-fetched fallback when JS is off                | live   | [g §decisions](../learning/g-reactions-in-browser.md#design-decisions--why-not-x)                                   | `src/templates/reactions.js` |
| Reply tree flattened, not nested                         | live   | [g §decisions](../learning/g-reactions-in-browser.md#design-decisions--why-not-x)                                   | `src/templates/reactions.js` |

### Build integrity

| Decision                                                          | Status | Rationale                                                                         | Code           |
| ----------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------- | -------------- |
| Shrink compared against a manifest, not the previous `dist/`      | live   | [h §decisions](../learning/h-builds-you-can-trust.md#design-decisions--why-not-x) | `src/guard.ts` |
| Manifest lives in the cache dir, not `dist/`                      | live   | [h §decisions](../learning/h-builds-you-can-trust.md#design-decisions--why-not-x) | `src/guard.ts` |
| `--force` is a flag, deliberately not config                      | live   | [h §decisions](../learning/h-builds-you-can-trust.md#design-decisions--why-not-x) | `src/cli.ts`   |
| `doctor` is a command, not `build --dry-run`                      | live   | [h §decisions](../learning/h-builds-you-can-trust.md#design-decisions--why-not-x) | `src/cli.ts`   |
| Distinct exit codes: 2 config, 3 network, 4 refused, 5 passphrase | live   | [h §decisions](../learning/h-builds-you-can-trust.md#design-decisions--why-not-x) | `src/cli.ts`   |
| No auto-retry of `pull` on a shrink                               | live   | [h §decisions](../learning/h-builds-you-can-trust.md#design-decisions--why-not-x) | `src/guard.ts` |

### Private & crypto

| Decision                                                     | Status | Rationale                                                                                  | Code                                |
| ------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------ | ----------------------------------- |
| Passphrase is an environment variable, not config            | live   | [i §decisions](../learning/i-private-by-capability.md#design-decisions--why-not-x)         | `src/private.ts`                    |
| Rendered HTML is encrypted, not the source markdown          | live   | [i §decisions](../learning/i-private-by-capability.md#design-decisions--why-not-x)         | `src/private.ts`                    |
| Paths derived by HMAC, not random UUIDs                      | live   | [i §decisions](../learning/i-private-by-capability.md#design-decisions--why-not-x)         | `src/crypto.ts`                     |
| 16 base32 characters of derived path                         | live   | [i §decisions](../learning/i-private-by-capability.md#design-decisions--why-not-x)         | `src/crypto.ts`                     |
| `sessionStorage`, not `localStorage`, for the unwrapped key  | live   | [i §decisions](../learning/i-private-by-capability.md#design-decisions--why-not-x)         | `src/client/decrypt.ts`             |
| A second, unreachable PDS — not encrypted records in one PDS | live   | [i §threat model](../learning/i-private-by-capability.md#the-threat-model-stated-honestly) | `src/identity.ts`, `docs/deploy.md` |

### Packaging & docs

| Decision                                               | Status | Rationale                                                            | Code             |
| ------------------------------------------------------ | ------ | -------------------------------------------------------------------- | ---------------- |
| `init <handle>` is a positional argument, not a prompt | live   | [j §decisions](../learning/j-ship-it.md#design-decisions--why-not-x) | `src/init.ts`    |
| `init` refuses to overwrite without `--force`          | live   | [j §decisions](../learning/j-ship-it.md#design-decisions--why-not-x) | `src/init.ts`    |
| `init` appends to `.gitignore` rather than writing it  | live   | [j §decisions](../learning/j-ship-it.md#design-decisions--why-not-x) | `src/init.ts`    |
| `docs/deploy.md` is separate from the README           | live   | [j §decisions](../learning/j-ship-it.md#design-decisions--why-not-x) | `docs/deploy.md` |
| The README describes the tool, not the journey         | live   | [j §decisions](../learning/j-ship-it.md#design-decisions--why-not-x) | `README.md`      |

### Field-test corrections (the superseding side)

| Decision                                            | Status | Rationale                                                                 | Code                     |
| --------------------------------------------------- | ------ | ------------------------------------------------------------------------- | ------------------------ |
| Leaflet blocks flatten to HTML, not markdown        | live   | [k §decisions](../learning/k-field-report.md#design-decisions--why-not-x) | `src/leaflet.ts`         |
| `format: "html"` still passes through the sanitizer | live   | [k §decisions](../learning/k-field-report.md#design-decisions--why-not-x) | `src/markdown.ts`        |
| The nav exists only when collections do             | live   | [k §decisions](../learning/k-field-report.md#design-decisions--why-not-x) | `src/build.ts`           |
| No cover thumbnails on list pages                   | live   | [k §decisions](../learning/k-field-report.md#design-decisions--why-not-x) | `src/templates/list.eta` |

### Post-course (ADRs)

| Decision                                                           | Status | Rationale                      | Code                        |
| ------------------------------------------------------------------ | ------ | ------------------------------ | --------------------------- |
| ADRs + hand-maintained map + frozen course; normal PRs from `main` | live   | [ADR 001](001-docs-process.md) | `AGENTS.md`, this directory |

### Publish & write

| Decision                                                                              | Status | Rationale                         | Code                                   |
| ------------------------------------------------------------------------------------- | ------ | --------------------------------- | -------------------------------------- |
| App-password auth via env, not OAuth (revisit: hosted use)                            | live   | [ADR 002](002-publish-command.md) | `src/write.ts`                         |
| Per-source `ATMO_APP_PASSWORD_<NAME>` overrides the generic var                       | live   | [ADR 002](002-publish-command.md) | `src/write.ts`                         |
| TOML `+++` frontmatter, not YAML                                                      | live   | [ADR 002](002-publish-command.md) | `src/frontmatter.ts`                   |
| rkey writeback into the file, not derived rkeys or a PDS query                        | live   | [ADR 002](002-publish-command.md) | `src/frontmatter.ts`, `src/publish.ts` |
| Unpublish requires the written-back rkey; `deleteRecord` only                         | live   | [ADR 002](002-publish-command.md) | `src/publish.ts`                       |
| `content` is a markdown string + always-written `textContent`; blocks writer deferred | live   | [ADR 002](002-publish-command.md) | `src/publish.ts`                       |
| Publish writes plaintext to the private PDS; encryption stays a build concern         | live   | [ADR 002](002-publish-command.md) | `src/write.ts`, `src/publish.ts`       |
| `--source` required with >1 source, no default; frontmatter source pinning            | live   | [ADR 002](002-publish-command.md) | `src/publish.ts`, `src/cli.ts`         |
| Strict parsing for operator input, unlike tolerant record parsing                     | live   | [ADR 002](002-publish-command.md) | `src/frontmatter.ts`                   |
| Exit code 6 = auth                                                                    | live   | [ADR 002](002-publish-command.md) | `src/cli.ts`, `src/write.ts`           |
