# g — Reactions in the browser

> **Stack:** g/j · **base:** `learn/f-personal-appview`
> **Diff:** `learn/f-personal-appview...learn/g-reactions-in-browser` ·
> **What it adds:** likes, reposts, replies and cross-app backlinks on each
> post — fetched **client-side**, after the page is already on screen, so the
> build never touches either service.

## The one-sentence version

Moving reactions off the server and into the browser deletes an entire
category of complexity — no cache tier, no timeout budget, no warming job, no
degraded-render story — because the page is already served by the time either
request is made.

## Learning objectives

**ATProto**

- **AppView vs backlink index**: `getPostThread` answers "what happened to
  _this Bluesky post_"; Constellation answers "who, in _any_ app, links to this
  target".
- Why a reply to your companion post _is_ a blog comment.
- Reading backlinks against **two targets** — the AT-URI and the canonical URL
  — because different apps link to different ones.
- **Double counting**, and the one-line rule that avoids it.

**Craft**

- Progressive enhancement: the page is complete without the script.
- Building DOM with `textContent`, never `innerHTML`, when the data is remote.
- Failure as a non-event — an outage means a smaller section, not an error.
- Configurable endpoints so nothing forces you through one provider.

## Grounding: official docs

- `app.bsky.feed.getPostThread` —
  <https://docs.bsky.app/docs/api/app-bsky-feed-get-post-thread>
- The bsky HTTP reference —
  <https://docs.bsky.app/docs/category/http-reference>
- Constellation — <https://constellation.microcosm.blue> · source —
  <https://github.com/at-microcosm/links>
- AT-URI — <https://atproto.com/specs/at-uri-scheme>
- CORS — <https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS>
- `Node.textContent` vs `innerHTML` —
  <https://developer.mozilla.org/en-US/docs/Web/API/Node/textContent>

## Background: two different questions

Your post can accumulate responses in two structurally different places.

**1. The AppView — Bluesky's view of one Bluesky post.** If your document
carries a `bskyPostRef`, there is a companion `app.bsky.feed.post` for it.
`getPostThread` returns that post with aggregated `likeCount` / `repostCount`
and a **tree of replies**. The insight worth sitting with: _a reply to your
companion post is exactly a blog comment._ Someone opens your article in
Bluesky, hits reply, types a paragraph — that paragraph is a first-class record
in **their** repo, and the thread stitches it in. You don't run a comment
system; you borrow one, and the commenter owns their words.

**2. A backlink index — anyone, in any app, pointing at you.** The AppView only
knows `app.bsky.*`. But your document has an AT-URI and your page has a URL,
and records in other lexicons link to either:
`site.standard.graph.recommend`, `pub.leaflet.comment`,
`com.whtwnd.blog.comment`, `sh.tangled.feed.star`, or something that didn't
exist when this was written. No AppView indexes all of those. **Constellation**
ingests the network and answers the inverse question: _give me every record
whose contents point at this target._

```
AppView        getPostThread   → "Bluesky's view of ONE post"     counts + replies
backlink index /links/all      → "who links here, ANYWHERE"        grouped by collection
```

They overlap — Constellation also sees `app.bsky.feed.like` — which is the
double-counting problem this branch has to solve.

## The decision that matters: this is client-side

The tempting design is to fetch these during `build` and bake them into the
HTML. Follow that thread:

- Counts freeze at build time and go stale immediately.
- A slow AppView slows every build.
- An AppView outage either fails the build or bakes in zeroes.
- You need a cache with a TTL, and a way to warm it.

Now compare the server-rendered version of the same feature, which is where
most blogs land. It sits on the **render path**, so it needs: a cache tier per
source, a short timeout separate from the normal one so a slow upstream can't
hang a reader's page, a cache-only mode for cold caches, and a background job
to warm it. That is four mechanisms and a cron entry to show a number.

Fetching in the browser after paint costs **none of them**. The reader already
has the post. If both services are down, the section stays empty and nothing
else is affected. There is no cache because there is no build-time value to
cache, and no timeout budget because nothing is waiting.

**Latency you don't block on doesn't need a budget.**

## Guided tour of the diff (read in this order)

1. **`src/config.ts`** — the `[reactions]` block: `mode`, and both endpoints as
   config. Nothing forces you through Bluesky's instance.

2. **`src/document.ts`** — `bskyRef`, probing three field names and both the
   string and strongRef shapes, because writers disagree.

3. **`src/templates/post.eta`** — the mount point. It carries every input the
   script needs as `data-` attributes and ships `hidden`.

4. **`src/templates/reactions.js`** — read `el()` first (the `textContent`
   rule), then `loadAppView`, then `loadBacklinks` and its `APPVIEW_OWNED`
   filter.

5. **`tests/reactions.test.ts`** — the build-side contract, plus an assertion
   that the shipped script contains no `innerHTML` at all.

## Deep dive: remote JSON must never become markup

Everything this script renders came from a third-party API describing text
strangers wrote. So there is exactly one way to put it on the page:

```js
function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // text, never markup
  return node;
}
```

`textContent` cannot create elements. A reply containing `<img onerror=...>`
becomes those literal characters on screen.

The alternative — building an HTML string and assigning `innerHTML` — would
reintroduce, in the browser, precisely the hole branch `d` closed at build
time. Worse, it would bypass the sanitizer entirely, because the sanitizer runs
during `build` and this content arrives afterwards.

There is a test asserting the emitted file contains no `innerHTML` anywhere.
That is a blunt instrument and deliberately so: a grep-level invariant survives
refactoring in a way that a carefully-reasoned code review does not. (It also
means the _comments_ can't use the word, which is why one says "text, never
markup".)

Two smaller notes: `credentials: "omit"` means no cookies ride along to a
third-party service, and the constructed `bsky.app` links get
`rel="noopener noreferrer"` for the same reason branch `d` gives every link.

## Deep dive: not counting the same like twice

Constellation indexes the whole network, which includes `app.bsky.feed.like`.
The AppView also reports likes. Naively summing gives every like twice.

```js
var APPVIEW_OWNED = ["app.bsky.feed.like", "app.bsky.feed.repost", "app.bsky.feed.post"];
...
if (APPVIEW_OWNED.indexOf(nsid) !== -1) return;
```

The rule: **for collections the AppView owns, trust the AppView; for everything
else, trust the index.** One source per fact.

The direction of the choice matters. The AppView's counts are its own
materialised view and are what a reader sees on bsky.app, so agreeing with it
is less confusing than being subtly off. Constellation's value is the
collections the AppView _cannot_ know — a `recommend` from a standard.site
reader, a `star` from Tangled.

And `LABELS` maps known NSIDs to human words while falling back to the raw
NSID. A brand-new app that starts linking to your posts shows up as a count
under its own name with **zero code changes** — the payoff of building on an
index instead of a list of integrations.

## Deep dive: two targets, one post

```js
var targets = [atUri, pageUrl].filter(Boolean);
```

Your article exists at two addresses. A standard.site-aware app links to the
**AT-URI** of your `site.standard.document`. A blog, a newsletter, or a
Mastodon post links to the **https URL**. Both are legitimate references to the
same writing, and querying only one silently loses half the responses.

This is a genuinely ATProto-shaped problem: content that exists both as a
protocol record and as a web page needs its backlinks looked up under both
identities.

## Design decisions & "why not X"

- **Why `hidden` on the mount point?** So a post with no responses shows
  nothing at all rather than an empty "Responses" heading. The script removes
  the attribute only once it has something to render.
- **Why `defer` on the script?** It must not block rendering. The entire
  argument for this design is that the reader gets the post first.
- **Why are the endpoints configurable?** Self-hosted AppViews and alternative
  indexes exist, and hardcoding a provider into a tool about data portability
  would be an odd thing to do.
- **Why plain ES5-flavoured JS with no build step?** It is copied verbatim into
  `dist/`, which keeps the emitted asset auditable — what you read is what
  ships. Adding a bundler for 180 lines would trade that for nothing.
- **Why not degrade to server-fetched when JS is off?** Because that would
  reintroduce the whole render-path apparatus for the small number of readers
  affected, and the _post_ — the thing they came for — is already complete
  without it. Reactions are the definition of an enhancement.
- **Why is the reply tree flattened rather than nested?** A blog comment
  section is a list. Preserving Bluesky's tree shape would mean designing an
  indentation scheme for conversations that mostly aren't nested.

## Review questions

1. _What would this feature need if it ran during `build` instead?_ — A cache
   with a TTL, a timeout so a slow upstream doesn't stall builds, a policy for
   an outage (fail? bake zeroes? keep stale?), and a way to refresh counts
   without a content change. All of it disappears client-side.
2. _Why query Constellation with both the AT-URI and the page URL?_ — Apps link
   to whichever identity they know. Protocol-aware ones use the AT-URI; the
   rest of the web uses the https URL. Querying one loses the other's
   responses.
3. _The script never uses `innerHTML`. What specifically would break if it
   did?_ — Reply text is arbitrary strings from strangers, fetched after the
   build. `innerHTML` would let a reply inject markup into your page, bypassing
   the sanitizer entirely because the sanitizer ran hours earlier.

## Exercises

1. **Verify CORS.** Open a built post and watch the network tab. If either
   request is blocked, that's the constraint this whole design rests on —
   what would you do about it?
2. **Break the dedup.** Remove the `APPVIEW_OWNED` filter on a post with real
   likes and compare the count to bsky.app. By how much is it wrong, and why?
3. **Add a source.** Pick an NSID from Constellation's response that isn't in
   `LABELS` and give it a human label. Then confirm an _unmapped_ NSID still
   renders under its raw name.
4. **Turn it off.** Set `mode = "off"`, rebuild, and diff the output. Which
   files disappear, and what does that tell you about the coupling?

## Verify it yourself

```bash
npm test -- reactions
npm run atmo -- build
grep -o 'data-[a-z-]*="[^"]*"' dist/posts/*/index.html | head
```

Then open a post in a browser with the network tab open — you should see two
requests fire _after_ the page renders.

## Watch & listen

- [Constellation](https://constellation.microcosm.blue) and
  [at-microcosm/links](https://github.com/at-microcosm/links) — read what a
  backlink index actually stores before reading `loadBacklinks`.
- [`getPostThread` reference](https://docs.bsky.app/docs/api/app-bsky-feed-get-post-thread)
  — call it by hand with `curl` against a real post and look at the envelope
  the flattening code walks.
- [astro-standard-site](https://github.com/musicjunkieg/astro-standard-site) —
  ships federated Bluesky comments too; a useful second implementation to
  compare against.

## Glossary

- **AppView** — a service materialising one app's view of the network.
- **Backlink index** — a service answering "what links to this target",
  across apps.
- **Companion post** — the `app.bsky.feed.post` a document points at, whose
  reply thread becomes the comment section.
- **Progressive enhancement** — the page is complete without the script; the
  script only adds.
- **Double counting** — the same reaction seen by two sources; solved by
  assigning one source per collection.
