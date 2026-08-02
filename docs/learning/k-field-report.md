# k — Field report

> **Stack:** k/k · **base:** `learn/j-ship-it`
> **Diff:** `learn/j-ship-it...learn/k-field-report` ·
> **What it adds:** a native renderer for Leaflet's `pub.leaflet.content`
> bodies, a safer `publication` default with a guard that notices when a filter
> eats everything, cover images that actually render, and nav + sitemap entries
> for collection pages — the four fixes from pointing the finished tool at a
> real repo.

> **This lesson supersedes earlier claims.** Field testing proved some things
> the earlier lessons state confidently to be wrong in practice: `c` treats
> `textContent` as an always-there fallback (Leaflet writes none), `c` and the
> example config present `publication = "self"` as a sensible pin (it hides
> every Leaflet post), `e` implies pulled blobs end up on pages (covers never
> did), and `f` calls collection pages reachable (nothing linked them). Where
> those lessons and this one disagree, **this one wins**. The earlier files are
> deliberately left unedited — the wrong-then-corrected sequence is the lesson.

## The one-sentence version

A bonus branch about what running your tool against a repo you didn't curate
teaches you: four features degraded **silently** — empty bodies, a default that
filtered out everything, covers fetched but never shown, orphaned pages — and
each one was a tolerant-parsing or defaults decision from an earlier branch
doing _exactly what it was told_.

## Learning objectives

**ATProto**

- What the open union in `site.standard.document`'s `content` field carries in
  the wild: Leaflet's `pub.leaflet.content` — pages of typed blocks, not text.
- **Facets**: inline formatting as UTF-8 **byte**-offset annotations over
  plaintext, the same model `app.bsky.feed.post` uses, and why byte offsets are
  not string indices.
- Why a lexicon's _de-facto_ writer matters more than its spec: `textContent`
  is optional, and the biggest writer omits it.

**Craft**

- Field testing as a distinct phase: unit tests prove code does what you meant;
  a real repo proves what you meant was wrong.
- The failure mode of tolerant parsing at scale: not crashes but **silence**,
  and how to buy the silence back with per-source accounting.
- Choosing defaults for other people's data, not your own.
- Reusing an existing seam (`atproto://getBlob?cid=`) so a new renderer gets
  blob fetching, sanitizing, and URL rewriting for free.

## Grounding: official docs

- Leaflet lexicons (`pub.leaflet.content`, `pub.leaflet.blocks.*`,
  `pub.leaflet.richtext.facet`) — <https://github.com/hyperlink-academy/leaflet>
- Bluesky on facets and byte slices —
  <https://docs.bsky.app/docs/advanced-guides/post-richtext>
- UTF-8 — <https://datatracker.ietf.org/doc/html/rfc3629>
- `TextEncoder` / `TextDecoder` —
  <https://developer.mozilla.org/en-US/docs/Web/API/TextEncoder>
- Open Graph protocol (`og:image`) — <https://ogp.me/>
- Sitemaps — <https://www.sitemaps.org/protocol.html>

## Background: the site that built fine and was wrong

Branch `j` shipped. The natural next step was to use the shipped thing on a
repo the course never touched: pfrazee.com, a real account with years of
Leaflet posts, statuses, and events. `atmo pull` worked. `atmo build` exited
zero. The guards from branch `h` found nothing to complain about.

The site was still wrong, four ways at once:

1. **Every post body was empty.** `content` is an open union, and the standard
   defines no variants — the de-facto shape is Leaflet's `pub.leaflet.content`,
   which `contentMarkdown`'s probe (branch `c`) does not understand. The
   designed fallback, `textContent`, would have saved us — but Leaflet doesn't
   write one. Tolerant parsing did its job perfectly: it degraded. To nothing.
2. **With `publication = "self"` pinned, zero posts rendered.** Leaflet
   assigns publications real TID rkeys; nothing in a Leaflet-written repo
   claims a publication named `self`. Every record positively claimed a
   _different_ publication, so branch `c`'s filter — correctly — excluded them
   all. `doctor` said nothing, because the empty-site check needs _both_ pages
   **and** collections to be empty, and the statuses collection existed.
3. **Cover images were pulled, cached, and copied** into `/assets/blobs/` —
   and no template ever referenced `doc.cover`. Branch `e` built the pipeline;
   nobody attached the last hose.
4. **Collection pages were orphaned.** Branch `f` renders them, but no nav
   links them and the sitemap doesn't list them. A page nothing links to
   effectively doesn't exist.

Notice what these four have in common: **no crashes**. Each is a reasonable
decision from an earlier branch — probe quietly, filter positively-conflicting
claims, copy blobs, render collections — composing into a site that is
confidently, silently degraded. Unit tests can't catch this class of bug,
because every unit did what its test says it should. Only feeding the system
input you didn't write does.

## Guided tour of the diff (read in this order)

1. **`src/leaflet.ts`** — the whole new module. Start with `leafletContent`'s
   detection at the bottom: what makes something a Leaflet body, and why the
   `{$type: "some.future.block", blocks: [1, 2]}` fixture from branch `c` must
   still fall through to `textContent`. Then `renderBlock` (the block table),
   then `facetedText` (the deep dive below).

2. **`src/document.ts`** — `isMarkdown: boolean` is gone. It couldn't say
   "already HTML", so `Document` now carries `format: "markdown" | "text" |
"html"` plus a new `text` field: the plaintext shadow of the body, feeding
   excerpts and feed descriptions so RSS never contains markup. `parseDocument`
   probes in order: markdown-ish fields, then `leafletContent`, then
   `textContent`.

3. **`src/markdown.ts`** — `renderBody` routes on the format; the new
   `renderHtml` is _just_ the sanitizer. The leaflet renderer only emits
   allow-listed tags, and its output goes through the same gate anyway —
   defense in depth, a bug there must not become an injection here. `u` and
   `mark` join `ALLOWED_TAGS` for the underline and highlight facets.

4. **`src/site.ts`** — three small things: `renderBody(doc.content,
doc.format)`, summaries from `doc.text`, and the new `sourceStats`
   accounting (records in → unparseable → pages out, per source). Also
   `Page.coverUrl`, preferring the _fetched_ mime type over the record's claim,
   because the fetched one decided the cached file's extension.

5. **`src/guard.ts`** — the `no-renderable-documents` error: a source with
   records but zero pages is the empty-site failure in a subtler coat, and a
   collection elsewhere can keep the `empty-site` check quiet. Note how the
   message names the publication filter only when parseable records existed.

6. **`src/config.ts` + `atmo.example.toml` + `src/init.ts`** — the default
   flips from `"self"` to `""` (no filter). `belongsToPublication` already
   treated `""` as "keep everything" back in branch `c`; only the default was
   wrong. Pinning becomes explicit opt-in, with the example configs explaining
   why.

7. **`src/build.ts` + templates** — nav is computed once, exists exactly when
   collections do, and is spread into every public page context; `post.eta`
   gains the cover `<figure>`; `base.eta` gains the guarded `og:image` and
   `site-nav`. `src/private.ts` builds its own contexts and deliberately gets
   no nav — the private shell stays bare.

8. **`src/feed.ts`** — one line: collections join the sitemap. Encrypted
   sources never reach `site.collections`, so the sitemap stays public.

9. **`tests/leaflet.test.ts`** — the block table, the detection nulls, and the
   facet fuzzing. Same spirit as branch `c`'s suite: most of it is about
   garbage.

## Deep dive: byte offsets are not string indices

A Leaflet facet looks like this:

```json
{
  "index": { "byteStart": 6, "byteEnd": 10 },
  "features": [{ "$type": "pub.leaflet.richtext.facet#bold" }]
}
```

Those offsets are positions in the **UTF-8 encoding** of the plaintext, and
JavaScript strings are **UTF-16** code units. For pure ASCII the two happen to
agree, which is exactly what makes the bug latent: every English test passes,
then the first emoji ships.

`"😀 bold"` is 7 UTF-16 code units (`"😀".length === 2` — a surrogate pair)
but **9 UTF-8 bytes** — the emoji alone takes four. A facet bolding `bold`
says bytes 5–9. Use those numbers with `String.prototype.slice` and you bold
`bold` minus one character and eat a surrogate half; use them after encoding
and they're simply correct:

```ts
const bytes = new TextEncoder().encode(plaintext); // slice in byte space
const segment = decoder.decode(bytes.subarray(byteStart, byteEnd));
```

So `facetedText` encodes once, does _all_ slicing in byte space, and decodes
each segment back at the edge. Hostile or buggy offsets get the branch-`c`
treatment: out-of-range, reversed, or overlapping facets are dropped (sorted
by start, first wins), and an offset landing _inside_ a multibyte character
just yields U+FFFD replacement characters from the non-throwing decoder — a
mangled decoration, never a lost post. The plaintext must survive any garbage
around it, because the facets are decoration and the words are the content.

Why does the lexicon use bytes at all? Because byte offsets are
language-neutral: Go, Rust, and Python agree on what byte 6 is, while "the 6th
character" depends on each language's string model. Bluesky's post facets made
the same call, for the same reason.

## Deep dive: one URL scheme, three branches of free behavior

The leaflet image block emits this placeholder:

```html
<img src="atproto://getBlob?cid=bafyreib…" alt="…" />
```

That exact shape is load-bearing three times over, all built in earlier
branches, none of them modified here:

1. **Discovery** — branch `e`'s `contentCids` scans body text with
   `/getBlob\?[^\s")']*\bcid=([A-Za-z0-9]+)/`, so `pull` finds the CID and
   fetches the blob into the cache. The leaflet renderer never talks to the
   network; it just writes a URL the existing crawler recognises.
2. **Sanitizing** — the allow-list in `markdown.ts` permits the `atproto:`
   scheme precisely so blob placeholders survive the sanitizer (that decision
   also dates to branch `e`). A `javascript:` URL in the same position dies.
3. **Rewriting** — `rewriteBlobUrls` runs on the _sanitized_ HTML and swaps
   any `getBlob` URL whose CID is cached for `/assets/blobs/<cid>.<ext>`. It
   runs after sanitizing so a rewrite can never reintroduce an attribute the
   sanitizer removed.

The lesson is about seams: because branch `e` expressed "this is a blob" as a
**syntactic convention in the HTML** rather than as a side channel, a renderer
written months later participates in the whole pipeline by emitting a string.
The seam check in `tests/leaflet.test.ts` pins it — `contentCids` must find
the CID in the renderer's output — so neither side can drift without a test
naming the other.

## Design decisions & "why not X"

- **Why flatten Leaflet to HTML instead of to markdown?** Fidelity and safety.
  Facets don't round-trip through markdown (`**` inside a word, overlapping
  emphasis, underline and highlight don't exist), and generating markdown from
  hostile input invites injection through the markdown parser itself.
  Rendering HTML directly, then sanitizing it like all other HTML, has one
  code path fewer to get wrong.
- **Why does `format: "html"` still go through the sanitizer?** The renderer
  is trusted code over untrusted input, and the sanitizer is the single
  choke-point the whole tool relies on. Skipping it for our own output means
  one renderer bug is an XSS. Sanitizing is cheap; auditing every future edit
  to `leaflet.ts` is not.
- **Why skip iframe/bskyPost/website/poll blocks rather than render
  something?** They're embeds and interactive controls; flattening them
  honestly needs either remote content at build time (branch `g` exists to
  avoid that) or a lie. Skipping loses a widget, not the words around it —
  and the plan is visible in `renderBlock`'s default case, not scattered.
- **Why is the new default `""` and not auto-detection of the repo's real
  publication?** Detection means the network at parse time and a guess that
  can silently change when a second publication appears. `""` is predictable:
  render what's there. The one repo-sharing use case (drafts) is exactly when
  the operator _knows_ the rkey and can pin it explicitly.
- **Why a new `no-renderable-documents` guard instead of widening
  `empty-site`?** Granularity. `empty-site` is about the whole model;
  this failure is per-source, and its message can name the likely cause
  (the filter vs. unparseable records) because `sourceStats` knows the
  difference. A merged check could only say "something is empty somewhere".
- **Why does the nav exist only when collections do?** A posts-only site's
  header would gain a single "Home" link pointing at itself. Navigation that
  navigates nowhere is decoration; the feature exists to make orphaned pages
  reachable, so it appears exactly when orphaned pages could.
- **Why no covers on list pages?** The record's cover is a page-level claim.
  Thumbnails on lists are a design feature with layout costs; `og:image` and
  the post page are where a missing cover was a _bug_. Smallest correct fix.

## Review questions

1. _Branch `c`'s tests all passed, yet every pfrazee.com post rendered empty.
   Which test was missing, and what general class does it belong to?_ — A test
   with a **real writer's** content shape, not one the author invented.
   Fixture-realism: unit fixtures encode the author's assumptions, and only
   input from the actual ecosystem tests the assumptions themselves.
2. _Why must `leafletContent` return `null` — not `{html: "", …}` — when every
   block was skipped?_ — `null` is the signal that lets `parseDocument` fall
   through to `textContent`. An empty-but-present body would win the probe and
   produce exactly the empty page this branch exists to kill.
3. _The facet says `byteStart: 5` and the text starts with an emoji. What goes
   wrong if you slice the JS string at index 5?_ — UTF-16 indices disagree
   with UTF-8 offsets from the first non-ASCII character: the emoji is 4 bytes
   but 2 code units, so index 5 lands three characters late and can split a
   surrogate pair, corrupting the text and the decoration.
4. _Why did the `publication = "self"` failure produce no guard finding before
   this branch?_ — The only relevant check was `empty-site`, which requires
   pages **and** collections to both be empty. The statuses collection
   existed, so the model wasn't "empty" — just wrong. Per-source accounting
   (`sourceStats`) is what makes the wrongness legible.
5. _What breaks if `rewriteBlobUrls` ran before sanitizing instead of after?_
   — The rewrite could reintroduce markup the sanitizer already judged — and
   the sanitizer would never see the final URLs. Order is the security
   property; branch `e` chose it and this branch leans on it.

## Exercises

1. **Write a hostile leaflet body.** A `link` facet with a `javascript:` URI,
   a `code` block whose language is `"><script>`, overlapping bold facets over
   an emoji. Confirm nothing throws, nothing injects, and the plaintext
   survives. The tests in `tests/leaflet.test.ts` are the answer key.
2. **Resurrect the bug.** Set `publication = "self"` in a config for a
   Leaflet-written repo (or fake the cache with records whose `site` claims a
   real rkey). Run `atmo build` and read the refusal; run `atmo doctor` and
   find the `N record(s) -> 0 page(s)` line. Then pin the _correct_ rkey and
   watch it build.
3. **Add a block type.** Leaflet's `website` block carries a URL and
   description. Render it as a plain `<a>` in a paragraph — decide what its
   plaintext contribution should be — without breaking the skip-list test.
4. **Find the next silence.** `doc.bskyPostUri` is parsed in branch `c` and
   threaded to the reactions section in `g`. Is anything else in `Document`
   parsed but never rendered? (Look at `tags` on private pages, or `updatedAt`
   in feeds.) Field-report thinking is transferable: _what does the model know
   that no template shows?_

## Verify it yourself

```bash
npm test                    # 281 tests (was 217)
npm run typecheck
npm run lint

# Against a real repo:
npm run build
mkdir /tmp/field && cd /tmp/field
node <repo>/dist/cli.js init pfrazee.com && node <repo>/dist/cli.js pull
node <repo>/dist/cli.js build
npx serve dist   # bodies, bold/links, images, covers, nav, /sitemap.xml
```

## Where this leaves the course

Branches `a` through `j` built a tool; this branch is the first one built from
evidence instead of intention. The four bugs share a genealogy — each was a
defensible decision reviewed and merged in an earlier branch, and no amount of
re-review would have caught them, because the code faithfully implemented its
author's model of the world. The model was what needed testing. Ship early
against data you didn't write; the repo you curate for tests is the one input
that can never surprise you.

## Glossary

- **Field test** — running the finished tool against input its authors didn't
  produce; the phase that tests assumptions rather than code.
- **Silent degradation** — a failure that produces a successful exit code and
  a wrong artifact; the characteristic failure mode of tolerant parsing.
- **Facet** — an inline-formatting annotation over plaintext, addressed by
  UTF-8 byte offsets; carries typed features (bold, link, …).
- **Plaintext shadow** — the `Document.text` field: the body flattened to
  text, feeding excerpts and RSS so markup never leaks into either.
- **Blob placeholder** — the `atproto://getBlob?cid=` URL convention that lets
  discovery, sanitizing, and rewriting treat any renderer's images uniformly.
- **Per-source accounting** — `sourceStats`: records in, unparseable, pages
  out; the numbers that turn a silent zero into a guard error.
