# j — Ship it

> **Stack:** j/j · **base:** `learn/i-private-by-capability`
> **Diff:** `learn/i-private-by-capability...learn/j-ship-it` ·
> **What it adds:** `atmo init`, npm packaging that actually works, a deploy
> guide, and a README that describes the tool rather than the journey.

## The one-sentence version

The last branch is about the gap between _works on my machine_ and _someone
else can use this_ — a scaffold that produces a config the real parser accepts,
a package whose `bin` resolves, and documentation organised by reader rather
than by chronology.

## Learning objectives

**Craft**

- A scaffold that writes the **minimum**, and why copying templates would be
  worse.
- Shipping non-TS assets from a TypeScript package: templates, CSS, a bundled
  browser script.
- Generated artifacts: build them, don't commit them, and hook the commands
  that need them.
- Documentation addressed to a reader, not to the author's memory.
- The deploy detail that silently disables every guard from branch `h`.

## Grounding: official docs

- npm `files` and `bin` —
  <https://docs.npmjs.com/cli/v10/configuring-npm/package-json>
- npm lifecycle scripts —
  <https://docs.npmjs.com/cli/v10/using-npm/scripts>
- esbuild — <https://esbuild.github.io/>
- GitHub Actions caching —
  <https://github.com/actions/cache>
- Divio's documentation system, on writing for a reader —
  <https://docs.divio.com/documentation-system/>

## Background: what "shipping" turns out to mean

Everything works. `npm test` is green and `npm run atmo -- build` renders a
site. None of that means anyone else can use it, and the gaps are boring and
specific:

- `tsc` compiles `.ts`. It does **not** copy `.eta`, `.css`, or `.js` — so a
  published package would have a working CLI and no templates.
- `bin` has to point at compiled output, and the entry-point guard from branch
  `a` has to still fire when the file is `dist/cli.js` rather than `src/cli.ts`.
- The browser bundle is a build artifact. Commit it and every diff carries 119 kB
  of minified noise; ignore it and any command that needs it must regenerate it.
- A first-time user has no `atmo.toml` and no idea what the fields are.

This branch closes those, and none of it is interesting except in the sense
that skipping it means the previous nine branches reach nobody.

## Guided tour of the diff (read in this order)

1. **`src/init.ts`** — `configFor` first. It returns a _string_, which is what
   makes the important test possible.

2. **`src/cli.ts`** — `init` is handled _before_ `loadConfig`, because it runs
   in a directory that has no config. Note that TypeScript then narrows `init`
   out of the switch, so the case had to be deleted — the compiler proving the
   early return is total.

3. **`package.json`** — `files`, `bin`, and the script chain: `bundle` produces
   the browser asset, `pretest` and `preatmo` depend on it, `build` runs it
   before `tsc` and then copies `src/templates` into `dist/`.

4. **`docs/deploy.md`** — read the paragraph about `atmo build`'s exit code.

5. **`tests/init.test.ts`** — read the first test.

## Deep dive: the scaffold's only real test

```ts
it("emits a config the real parser accepts", () => {
  const config = parseConfig(configFor({ handle: "you.example.com" }));
  expect(config.source[0]).toMatchObject({ name: "posts", handle: "you.example.com" });
});
```

Scaffolds rot in a specific way: someone adds a required config field, updates
the schema, updates their own `atmo.toml`, and never touches the template
string. The generated config is then broken for every new user and nobody
notices, because the authors all have working configs already.

Feeding the scaffold's output through the **real parser** in a test closes that
permanently. Add a required field without updating the template and this test
fails immediately. It works because `configFor` returns a string and
`parseConfig` takes one — a decision made back in branch `a` for testability,
paying off in a place nobody predicted.

The same test also documents the commented-out sources: it asserts exactly one
source parses, so the private-source example can't accidentally be active.

**`init` deliberately copies no templates.** Branch `d`'s search path means an
empty `templates/` directory already inherits every default, so copying them
would give the user a pile of files to read, most of which they'll never
change, and every one of which is now forked from upstream and will not receive
improvements. An empty directory with a `.gitkeep` explaining what goes in it
is more useful than eight files that look like they need editing.

## Deep dive: shipping what isn't TypeScript

Three asset classes, three mechanisms:

```json
"bundle": "esbuild src/client/decrypt.ts --bundle --format=esm --minify --outfile=src/templates/decrypt.js",
"build":  "tsc && npm run bundle && node -e \"require('fs').cpSync('src/templates','dist/templates',{recursive:true})\"",
"pretest":"npm run bundle",
"preatmo":"npm run bundle",
```

- **Templates and CSS** are copied verbatim into `dist/templates/`, where
  `BUILTIN_TEMPLATES` — resolved relative to the compiled module — finds them.
  This is why that constant used `import.meta.url` rather than a relative path
  from the working directory.
- **`reactions.js`** ships as-is. It has no imports, so what you read in the
  repo is byte-for-byte what runs in a reader's browser. That auditability was
  worth more than the convenience of a bundler.
- **`decrypt.js`** cannot ship as-is, because it imports `age-encryption`.
  Browsers can't resolve bare specifiers, and a CDN import would defeat the
  point of a self-contained site. So esbuild bundles it — and because the
  output is _generated_, it's gitignored and regenerated by the `pre` hooks of
  every command that needs it.

The `pretest` hook matters more than it looks: the private tests build a real
site, which resolves the `decrypt.js` template. Without the hook, a fresh clone
fails its test suite for a reason with no obvious connection to the failure.

## Deep dive: the deploy line that undoes branch `h`

Branch `h` made `build` exit non-zero when the site looks wrong, and the
`docs/deploy.md` workflow relies on one property:

```yaml
- run: atmo build
- uses: actions/upload-pages-artifact@v3
```

Sequential steps in one job: a non-zero exit stops the job, so the upload never
runs. The guards work.

Now the failure mode. Split the upload into its own job, or put it in a
different workflow triggered by `workflow_run`, and the deploy fires
**regardless of whether the build refused**. The guards are still there, still
correct, still tested — and completely bypassed.

This is the general shape of the thing: **a safety mechanism is only as good as
the pipeline that respects its exit code.** The docs call it out explicitly,
because it is the single most likely way a user ends up with the empty site
branch `h` exists to prevent.

## Design decisions & "why not X"

- **Why `init <handle>` as a positional rather than a prompt?** Scriptable, and
  a prompt is a dependency plus a testing problem. The handle is the one thing
  the tool genuinely cannot guess.
- **Why does `init` refuse to overwrite without `--force`?** Clobbering a
  hand-edited config is unrecoverable and the command is easy to run twice.
- **Why append to `.gitignore` rather than write it?** Users have one already.
  The check for an existing `.atmo/` entry makes a second run a no-op, and a
  test asserts it.
- **Why is `docs/deploy.md` separate from the README?** Different readers. The
  README answers "what is this and how do I start"; deploy answers "I have it
  working, now what". Merging them means everyone reads both.
- **Why doesn't the README describe the branch structure?** Because a user
  doesn't care how it was built. The course lives in `docs/learning/`, linked
  once. Documentation that narrates the codebase's history is documentation for
  its authors.

## Review questions

1. _What breaks if `files` in `package.json` lists only `dist` and `tsc`
   doesn't copy templates?_ — The CLI installs and runs, then fails at the
   first render with "no template named base.eta". Every command that touches
   output is broken; nothing about the failure points at packaging.
2. _Why is `decrypt.js` bundled but `reactions.js` shipped raw?_ — Only
   `decrypt.js` imports a dependency. Bundling the other would trade
   auditability for nothing.
3. _You move the deploy into a separate workflow. What have you lost?_ —
   Branch `h` entirely. The upload no longer depends on the build's exit code,
   so a refused build publishes anyway.

## Exercises

1. **Install it for real.** `npm pack`, then `npm install -g ./atmo-0.0.0.tgz`
   in a clean directory, and run `atmo init` + `pull` + `build`. Anything
   missing is a `files` bug.
2. **Break the scaffold.** Add a required field to `ConfigSchema` without
   touching `configFor`. Which test fails, and how long would that bug have
   survived otherwise?
3. **Break the pipeline.** Move the upload step into its own job with no
   `needs:`. Make the build fail a guard. Watch it deploy anyway. Put it back.
4. **Trigger on the firehose.** Sketch the Jetstream-filtered rebuild from the
   deploy guide. What does it cost to run, and when is an hourly cron better?

## Verify it yourself

```bash
npm run build
node dist/cli.js --version
ls dist/templates/          # base.eta, post.eta, decrypt.js, collections/…

npm test                    # 217 tests
```

## Where this leaves the course

Bottom to top: a config and a command split (`a`), reading a repo (`b`),
treating its records as hostile (`c`), rendering them (`d`), pulling the images
local (`e`), rendering collections other apps wrote (`f`), moving reactions off
the build entirely (`g`), refusing to publish a broken site (`h`), encrypting
the private half with someone else's crypto (`i`), and packaging it so the
whole thing reaches someone other than you (`j`).

What you end up with is a renderer, not a platform. Your writing was already
portable before `atmo` existed and stays portable if you delete it — which is
the only real test of whether a tool respects your data. The site is a thin,
replaceable house; the home is the repo, and the repo is yours.

## Glossary

- **Scaffold** — generated starting files; correct only if its output is tested
  against the real parser.
- **Generated artifact** — built, not committed, and regenerated by the
  commands that need it.
- **`files` / `bin`** — what npm publishes and what it links onto `$PATH`.
- **Pipeline respect** — the property that a deploy step actually depends on a
  build's exit code.
