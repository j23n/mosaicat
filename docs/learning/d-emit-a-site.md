# d — Emit a site

> **Stack:** d/j · **base:** `learn/c-records-are-hostile`
> **Diff:** `learn/c-records-are-hostile...learn/d-emit-a-site` ·
> **What it adds:** `atmo build`. Markdown rendering with sanitizing, a site
> model, an overridable template layer, index/post/tag pages, pagination, RSS,
> a sitemap, and `robots.txt`. The first branch that produces a website.

## The one-sentence version

`build` reads the cache, renders every document's markdown through a
**sanitizer** because a record's body was written by someone else, assembles a
**site model** that is a pure function of what's on disk, and writes it out as
files — so the same cache always produces the same bytes.

## Learning objectives

**Craft**

- **Routing as paths**: a URL is a directory with an `index.html`, and that's
  the whole router.
- Rendering untrusted markdown: allow-lists, not deny-lists, and why the
  distinction is total.
- A **site model** separated from emission, so ordering and pagination are
  testable without touching a filesystem.
- **Template overriding** by search path — drop in one file, change one thing.
- Why the output directory is cleared before every build.
- Deterministic output as a testing strategy.

**ATProto**

- _(light)_ — everything here is downstream of branch `c`'s `Document`. The one
  protocol-shaped decision is that page URLs come from `path`/rkey rather than
  anything the site invents.

## Grounding: official docs

- marked — <https://marked.js.org/> · GFM spec —
  <https://github.github.com/gfm/>
- sanitize-html — <https://github.com/apostrophecms/sanitize-html>
- Eta templates — <https://eta.js.org/>
- OWASP XSS prevention —
  <https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html>
- RSS 2.0 — <https://www.rssboard.org/rss-specification>
- Sitemaps protocol — <https://www.sitemaps.org/protocol.html>
- `rel="noopener noreferrer"` —
  <https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/noopener>
- microformats2 h-entry — <https://microformats.org/wiki/h-entry>

## Background: a static site has no router

In a server-rendered app a request arrives, a router matches a pattern, a view
runs. None of that exists here. The "router" is the shape of a directory:

```
/                    ->  dist/index.html
/page/2/             ->  dist/page/2/index.html
/posts/my-title/     ->  dist/posts/my-title/index.html
/tags/notes/         ->  dist/tags/notes/index.html
/feed.xml            ->  dist/feed.xml
```

Every URL ends in a slash and becomes a directory containing `index.html`. That
convention costs nothing and buys two things: relative links inside a page
behave predictably, and every static host serves it without configuration.

Path prefixes come from the **source name** by default — source `posts` renders
under `/posts/`, source `private` under `/private/`. Since source names are
already unique (branch `a` enforces it), two sources can never silently collide
into the same URL. `path_prefix` overrides it when you want `/writing/`.

The other half of this branch is that **the body is untrusted**. Branch `c`
established that records are hostile input and shaped their _fields_ safely.
The `content` field survived that process as a string — and markdown, by
design, permits raw HTML. So the string that reaches a page can contain
`<script>`. Rendering it verbatim would be an XSS hole with a very long
half-life, because static output is cached, mirrored, and archived.

## Guided tour of the diff (read in this order)

1. **`src/markdown.ts`** — the allow-list, then `renderMarkdown`. Note that
   sanitizing happens _after_ markdown rendering, not before: markdown can
   _produce_ HTML, so sanitizing the source would miss it.

2. **`src/site.ts`** — the model. `loadSite` reads the cache and returns
   everything the templates need. No `fs` beyond the cache read, no network, no
   clock. Read `publicPages` and the comment above the tag loop.

3. **`src/render.ts`** — the template search path. Two roots, project first.
   Note that `formatDate` is _injected_ into the context rather than imported
   by templates.

4. **`src/templates/`** — `base.eta` is the layout, `post.eta` and `list.eta`
   the two page types. `<%= %>` escapes; `<%~ %>` doesn't, and appears exactly
   twice — for the already-sanitized body and the already-rendered page body.

5. **`src/feed.ts`** — RSS, sitemap, robots. All three take `publicPages`.

6. **`src/build.ts`** — orchestration. Note the `rm` before the `mkdir`.

7. **`tests/build.test.ts`** — read the sanitizer table and the
   "clears the output directory" test.

## Deep dive: two escaping systems, and where each applies

There are two completely different jobs here, and conflating them is the
classic way to ship an XSS bug.

**Job one: a title in an attribute or a text node.** The value is _data_. It
must never become markup. Eta's `<%= %>` escapes it, and every title, summary,
and tag name in the templates uses it. A post titled
`<script>alert(1)</script>` renders as visible text — there is a test asserting
exactly that.

**Job two: a body that is _meant_ to be markup.** Markdown must produce real
`<h1>`, `<em>`, `<a>`. Escaping it would show the reader raw tags. So it goes
through `marked` and then through `sanitize-html`, and only then into `<%~ %>`.

The ordering matters and is easy to get backwards:

```
source markdown ──marked──► HTML (may contain anything) ──sanitize──► safe HTML
```

Sanitizing _before_ marked would be useless: the markdown `<script>x</script>`
might survive as text and be re-emitted as a tag by the renderer. Sanitize the
thing you are about to output, never its input.

**Allow-list, not deny-list.** `ALLOWED_TAGS` names about thirty tags and
everything else is dropped. The alternative — banning `<script>`, `<iframe>`,
`<object>`… — loses to the first tag you didn't think of, and to
`<img onerror=…>`, which uses no forbidden tag at all. That's why attributes
are allow-listed too: `img` may have `src`, `alt`, `title`, `loading`, and
nothing else, so `onerror` never survives.

**Schemes are allow-listed separately** because `<a href="javascript:…">` uses
a perfectly ordinary tag and attribute. Only `http`, `https`, `mailto`, and
`atproto` pass.

**Every link gets `rel="noopener noreferrer"`.** `noopener` closes
reverse-tabnabbing. `noreferrer` matters much more than it looks: it stops the
current URL leaking to the destination — and in branch `i` the current URL _is_
the capability that grants access to a private post. One outbound link from a
private page without this header hands that capability to a stranger's access
log.

Note the subtlety that made this fail first time: `rel` had to be added to
`allowedAttributes` as well. The transform adds it, then the sanitizer strips
any attribute not on the list — including one the sanitizer itself just added.

## Deep dive: model, then emit

`loadSite` and `build` are deliberately separate.

`loadSite` is a pure-ish function: cache in, `SiteModel` out. Ordering,
pagination boundaries, tag grouping, summary fallbacks — all decided here,
where they can be asserted directly:

```ts
const site = await loadSite({ ...config, page_size: 2 });
expect(site.index[0].nextUrl).toBe("/page/2/");
```

No temp directory, no HTML parsing, no guessing which `<a>` was the pagination
link. `build` then does I/O and nothing else interesting.

That split is what makes branch `h` possible. A guard that refuses to publish a
suspiciously empty site needs to inspect the model **before** anything is
written. If pagination were computed while emitting, there would be no moment
at which the whole picture exists and the disk is untouched.

`missingSources` is the first hint of that. A source with no cache entry is
_recorded_, not thrown — `build` warns, and branch `h` upgrades it to a
refusal.

**Why clear `dist/` first?** Delete a post, rebuild, and without the `rm` its
`index.html` remains — served forever, linked from nowhere, invisible to you
and reachable by anyone who has the URL. A build that only ever adds files
drifts away from the truth silently. There is a test for this, and it is more
important than it looks.

## Deep dive: overriding one template

```ts
const roots = existsSync(overrides) ? [overrides, BUILTIN_TEMPLATES] : [BUILTIN_TEMPLATES];
```

Resolution walks the roots in order and takes the first hit. To restyle post
pages you create `templates/post.eta` in your project; everything else keeps
using the bundled version. You are never forced to fork a whole theme to change
one thing.

`atmo.css` goes through the same resolver, which is why the stylesheet is a
"template" — it costs nothing and makes the override story uniform.

`formatDate` is injected into every context rather than imported by templates.
A template is user-editable content, and giving it a module import is giving it
the whole module graph. Pass in the capabilities it needs; don't hand it the
keys.

## Design decisions & "why not X"

- **Why Eta rather than Handlebars, Nunjucks, or JSX?** It's tiny, it escapes
  by default (`<%= %>`), and the unescaped form is visually distinct
  (`<%~ %>`) — you can audit every unescaped interpolation by grepping for one
  character. Escaping-by-default with a _loud_ opt-out is the property that
  matters; the syntax is secondary.
- **Why sanitize at build rather than trusting the author?** Because the author
  might not be you. The whole premise is rendering repos, including — in branch
  `f` — collections written by other apps entirely. And a static page's XSS is
  worse than a server's: it's cached at the edge and archived.
- **Why does the feed carry summaries, not full content?** Full-content feeds
  mean re-sanitizing for a completely different consumer with different rules.
  Summaries are plain text and cannot carry markup at all.
- **Why is `robots.txt` disallowing `/p/` already, before branch `i` exists?**
  Because the alternative is remembering to add it later, at exactly the moment
  a mistake is least recoverable. Costs one line now.
- **Why don't tag pages paginate?** Simplicity, and a tag with hundreds of
  entries is rare enough that the reader is better served by one long list than
  by hunting through pages. Revisit if it stops being true.
- **Why derive `summary` from an excerpt instead of leaving it empty?** The
  feed and the index both want one, and `description` is optional in the
  lexicon — so most real records don't have it.

## Review questions

1. _Why is sanitizing done after markdown rendering rather than before?_ —
   Markdown _generates_ HTML. Sanitizing the source leaves the generated output
   unchecked, and the generator can turn benign-looking input into tags.
2. _Both `<%= %>` and `<%~ %>` appear in the templates. What has to be true
   about every `<%~ %>` site?_ — Its value must already be sanitized HTML. There
   are two: the post body (through `sanitize-html`) and the page body (composed
   of already-rendered fragments). Any third one is a bug.
3. _`build` clears `dist/` on every run. What does that cost, and why is it
   worth it?_ — It costs incremental rebuilds, so a large site re-renders
   everything. It buys the guarantee that output never contains a file the
   current model didn't produce — no orphaned pages from deleted posts.

## Exercises

1. **Try to get a script through.** Add a record whose title, summary, tags,
   and body all contain `<script>`, `<img onerror>`, and
   `<a href="javascript:">`. Build it and grep the output for `<script`. Then
   remove `sanitize-html` from `renderMarkdown` and grep again.
2. **Override a template.** Create `templates/post.eta` in a project directory
   and add a "back to index" link. Confirm the index page is untouched.
3. **Break determinism.** Put `new Date()` in the base template's footer.
   Build twice and diff the output. Why does branch `h` care?
4. **Add a page type.** Emit `/archive/`: every post grouped by year, no
   pagination. Which file do you touch, and how much of `build.ts` changes?

## Verify it yourself

```bash
npm test                     # 123 tests

# render a real site
npm run atmo -- pull
npm run atmo -- build
npx serve dist               # or: python3 -m http.server -d dist
```

## Watch & listen

- [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
  — read the context-dependent-escaping section alongside the two-jobs deep
  dive above.
- [sanitize-html's README](https://github.com/apostrophecms/sanitize-html) —
  the options list is a good tour of what a sanitizer has to think about.
- [microformats h-entry](https://microformats.org/wiki/h-entry) — the classes
  in `post.eta` are not decoration; they make the page machine-readable to
  IndieWeb tooling.

## Glossary

- **Site model** — the whole site as data, derived from the cache, before any
  file is written.
- **Allow-list** — permit a known-good set, drop everything else. The only
  sanitizing strategy that survives contact with input you didn't imagine.
- **Template search path** — ordered roots, first match wins; the mechanism
  behind single-file overrides.
- **Deterministic build** — same input, same bytes out; the precondition for
  comparing output in tests and for branch `h`'s guards.
- **Routing as paths** — a URL is a directory containing `index.html`.
