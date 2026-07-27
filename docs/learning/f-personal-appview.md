# f — The personal AppView

> **Stack:** f/j · **base:** `learn/e-blobs-as-assets`
> **Diff:** `learn/e-blobs-as-assets...learn/f-personal-appview` ·
> **What it adds:** pages for collections you never wrote. Point a source at
> `sh.tangled.repo` or `buzz.bookhive.book` and those records render on your
> site, through a template chosen by NSID — with a generic fallback for
> lexicons that don't exist yet.

## The one-sentence version

Your repo already holds records that _other apps_ wrote on your behalf, and
because a repo read is unauthenticated and a NSID is a public contract, your
own site can render them — indexing exactly one repo at build time, which is an
**AppView** in every sense except scale.

## Learning objectives

**ATProto**

- The **personal AppView** pattern: one repo, at build time, no firehose, no
  index, no database.
- **NSID as contract**: the reverse-DNS name is the entire interface between an
  app that writes a record and an app that reads it.
- Reading lexicons you did not design, and did not coordinate with.
- Why app-neutral data is the actual payoff of putting content in a repo.

**Craft**

- A **registry keyed by type name** implemented as nothing but an ordered
  template search.
- Designing a **generic fallback renderer** that assumes no fields exist.
- Flattening arbitrary nested JSON for display without recursing forever.
- Ordering records when you don't know which field is the timestamp.

## Grounding: official docs

- Lexicon — <https://atproto.com/specs/lexicon>
- NSID — <https://atproto.com/specs/nsid>
- Repository / collections — <https://atproto.com/specs/repository>
- `com.atproto.repo.listRecords` —
  <https://docs.bsky.app/docs/category/http-reference>
- Tangled — <https://tangled.org> · BookHive — <https://bookhive.buzz>
- Bluesky's own lexicons, as examples of the genre —
  <https://github.com/bluesky-social/atproto/tree/main/lexicons>

## Background: what an AppView is, and why yours is legitimate

A **collection** is named by an **NSID** — a reverse-DNS string like
`sh.tangled.repo` — and that name is declared by whoever controls the domain.
The crucial property is that **the record is app-neutral**. When you create a
repository on [Tangled](https://tangled.org), it writes a `sh.tangled.repo`
record into _your_ PDS. When you shelve a book on
[BookHive](https://bookhive.buzz), it writes `buzz.bookhive.book` into _your_
PDS. Those records are yours. They sit in your repo. They have AT-URIs.

Nothing stops your website from listing them.

An **AppView** is a service that reads repos and materialises them into
something queryable. Bluesky's ingests the whole network's firehose and indexes
millions of accounts. Yours indexes exactly one — at build time, with a single
unauthenticated `listRecords` call per collection. Same shape, four orders of
magnitude less machinery:

```
Bluesky AppView   firehose → index → query → render      (continuous, huge)
atmo              listRecords → template → HTML          (once per build, one repo)
```

That is the argument for the whole approach in one line: **the data is
app-neutral, so the renderer is a choice.** You didn't negotiate with Tangled.
You didn't ask BookHive for an API key. You read the NSID they publish records
under and rendered it.

The design problem this creates: you cannot possibly have a template for every
lexicon, and new ones appear constantly. So the renderer has to work for a
lexicon it has never seen.

## Guided tour of the diff (read in this order)

1. **`src/collection.ts`** — `parseItem` first, then `flatten` (the recursion
   guard), then `collectItems` (the ordering compromise), then
   `templateCandidates` — which is the whole "registry", and is two strings.

2. **`src/templates/collections/default.eta`** — the fallback. Read it noting
   that it references exactly three things: `label`, `at`, and `fields`. All
   three are computed for _any_ record.

3. **`src/templates/collections/buzz.bookhive.book.eta`** — the contrast. This
   one reads named fields, because it knows the lexicon.

4. **`src/render.ts`** — `findTemplate`, an ordered search over
   `[project, builtin] × [specific, default]`.

5. **`src/site.ts`** — the loop that turns every non-document collection into a
   page, and skips encrypted sources.

6. **`tests/collection.test.ts`** — read "renders an invented lexicon through
   the generic template."

## Deep dive: a registry that is just a search path

Here is the entire type-dispatch mechanism:

```ts
export function templateCandidates(nsid: string): string[] {
  return [`collections/${nsid}.eta`, "collections/default.eta"];
}
```

Combined with branch `d`'s two-root search, resolution tries four locations in
order:

```
templates/collections/buzz.bookhive.book.eta      ← your override
src/templates/collections/buzz.bookhive.book.eta  ← shipped, if we know it
templates/collections/default.eta                 ← your generic override
src/templates/collections/default.eta             ← shipped fallback
```

No registration call, no map, no plugin interface, no `if` chain. **Adding
support for a lexicon means adding a file whose name is the NSID.** Users do it
without touching the codebase; the project does it by shipping one more
template.

Compare the alternatives. A `Map<string, Renderer>` needs a registration site
and an extension mechanism. A `switch` on NSID needs a code change per lexicon
and a release to ship it. Both are more machinery than "look for a file with
this name," and neither lets a user support their own lexicon without forking.

This is the same idea as branch `d`'s single-file override, applied one level
up: the _filename_ carries the dispatch.

## Deep dive: rendering a record you know nothing about

The fallback template can't assume any field exists, so `parseItem` computes
three things that are always available:

**A label.** Try `name`, `title`, `displayName`, `subject`, `text`,
`description`, in that order; fall back to the rkey. Six guesses covering most
lexicons, and a guaranteed non-empty answer.

**A date, maybe.** Try `createdAt`, `publishedAt`, `indexedAt`, `updatedAt`,
`startedAt`, `finishedAt`. Unlike branch `c`'s documents, a date here is
genuinely optional — a `sh.tangled.repo` record may not have one, and that's
fine.

**Flattened fields.** Every remaining key, rendered as a short string.

`flatten` is where the care goes:

```ts
if (Array.isArray(value)) {
  if (depth > 1) return `[${value.length} items]`;
  return value
    .map((e) => flatten(e, depth + 1))
    .filter(Boolean)
    .join(", ");
}
```

The `depth` guard matters. A record can nest arbitrarily, and a naive recursive
stringifier on a hostile or merely deep record either produces a wall of text or
blows the stack. Two levels, then a summary. Nested objects get the same
treatment, with two shortcuts worth noting: an object with a recognisable label
field shows that label, and an object with `$link` shows the CID — because a
blob ref rendered as `{ref, mimeType, size}` is noise, while the CID is at
least identifying.

`$type` is dropped from the field list because it's already the page heading.

## Deep dive: ordering without a schema

Branch `c` had a rule — sort by `publishedAt`, full stop. Here there is no
guaranteed timestamp at all, so the compromise is explicit:

```ts
const dated = items.filter((i) => i.at !== null);
const undated = items.filter((i) => i.at === null);
dated.sort((a, b) => b.at!.getTime() - a.at!.getTime());
return [...dated, ...undated];
```

Dated records sort newest-first. Undated ones keep **wire order**, which is
rkey-descending from branch `b`'s `reverse=true` — and since rkeys are usually
TIDs, that is approximately creation order. It's the only ordering signal
available when the record carries none.

Putting undated records _after_ dated ones rather than interleaving them is a
deliberate choice: mixing them would require inventing a position, and any
invented position is a lie about the data. Two groups is honest.

## Design decisions & "why not X"

- **Why render collections at `/<source>/<nsid>/` rather than a pretty slug
  like `/books/`?** The NSID is unique and unambiguous; a pretty name requires a
  mapping table and collides the moment two lexicons both want "books".
  `path_prefix` already exists if you want a nicer URL for a whole source, and
  an override template can link to it.
- **Why ship a BookHive template at all?** As a worked example. The fallback
  proves the mechanism works for anything; a real one shows what a good template
  looks like and gives users something to copy.
- **Why not fetch lexicon schemas and generate templates from them?** It's an
  appealing idea and it fails on presentation: a schema tells you a field is a
  string, not that it's a book title deserving an `<h2>`. Rendering is a design
  decision, not a derivable one.
- **Why are collection pages excluded for encrypted sources?** Same reason tag
  pages are in branch `d` — a listing of a private source's records is a leak of
  exactly the thing branch `i` is protecting.
- **Why not paginate collection pages?** A personal repo's collections are
  small, and `max_records` already bounds them. Revisit when it stops being
  true.

## Review questions

1. _A new app ships `com.example.workout` tomorrow and writes records into your
   repo. What do you have to change to get a page?_ — Add the NSID to your
   source's `collections`. That's all; the generic template renders it. Writing
   `templates/collections/com.example.workout.eta` is optional polish.
2. _Why does `flatten` stop at depth 2 rather than rendering everything?_ —
   Arbitrary depth means arbitrary output size and stack depth on input you
   don't control. The summary form (`[3 items]`) keeps the page readable and
   the function total.
3. _Undated records are appended rather than interleaved. What would
   interleaving require?_ — Inventing a timestamp for them — from the rkey, or
   from position. Both are fabrications presented as data.

## Exercises

1. **Render something real.** Add `sh.tangled.repo` to your source's
   `collections`, pull, and build. You'll get a page from the generic template.
   Now write `templates/collections/sh.tangled.repo.eta` and make it good.
2. **Break the depth guard.** Construct a record nested ten levels deep and
   confirm the page still renders. Then remove the `depth > 1` checks and see
   what the page looks like.
3. **Improve the label search.** Find a lexicon whose display name isn't in
   `LABEL_KEYS`. Add it — and then argue whether growing that list indefinitely
   is the right strategy, or whether per-NSID templates should carry it.
4. **A second source.** Configure two sources against the same handle with
   different collections. Confirm the URLs don't collide, and explain which
   branch's decision guarantees that.

## Verify it yourself

```bash
npm test -- collection
npm run atmo -- pull && npm run atmo -- build
find dist -name index.html | grep -v posts
```

## Watch & listen

- ["Did Lexicon just accidentally solve the enterprise data problem?"](https://ionosphere.tv/talks)
  — Emily Gorcenski, ATmosphereConf. The argument that Lexicon is a general
  decentralised data-modelling language is exactly what this branch exploits.
- [Introduction to AT Protocol](https://mackuba.eu/2025/08/20/introduction-to-atproto/)
  — mackuba's AppView section, read against `collection.ts`.
- **Go looking.** Open your own repo on [pdsls.dev](https://pdsls.dev) and list
  the collections in it. Most people are surprised how many apps have written
  something there.

## Glossary

- **AppView** — a service that reads repos and materialises them for display.
  Yours reads one.
- **NSID** — reverse-DNS collection name; the contract between writer and
  reader.
- **App-neutral data** — records usable by any app, because the schema is
  public and the storage is yours.
- **Template registry** — dispatch by filename: `collections/<nsid>.eta`, then
  `collections/default.eta`.
- **Generic renderer** — a template that assumes no field exists, so an unknown
  lexicon still produces a page.
