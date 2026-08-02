# c — Records are hostile input

> **Stack:** c/j · **base:** `learn/b-read-a-repo`
> **Diff:** `learn/b-read-a-repo...learn/c-records-are-hostile` ·
> **What it adds:** `src/document.ts` — the layer that turns arbitrary JSON out
> of a repo into a typed `Document` a template can render, and 50 tests whose
> real subject is everything that can go wrong.

## The one-sentence version

A repo is not a database and nobody validated what went into it, so parsing is
**tolerant by construction**: two fields are required, every other field
degrades to a default, no record shape can throw, and the order readers see
comes from a value _inside_ the record rather than from the order the wire
delivered it.

## Learning objectives

**ATProto**

- What a `site.standard.document` actually contains, and which parts you can
  rely on (almost none).
- **Open unions**: `content` can carry a block type that didn't exist when your
  code was written, and your code still has to work.
- **Publications partition a repo**: a document names its publication in
  `site`, and pinning one rkey is how drafts and posts coexist in one repo.
- Blob refs as they appear inside records, in both the `{ref: {$link}}` and
  legacy shapes.
- Why `publishedAt` and TID ordering **disagree**, and which one is the
  contract.

**Craft**

- Writing a parser where **skip** is the failure mode, never **throw**.
- Requiring the minimum: what genuinely cannot be defaulted?
- Table-driven tests (`it.each`) as the readable form of "and all of these
  too."
- Deriving identity from the envelope, defaults from the payload.
- Why the _absence_ of a convention must be tolerated while a _conflicting_
  claim is not.

## Grounding: official docs

- `standard.site` lexicons — <https://standard.site/>
- Lexicon, and what an open union means —
  <https://atproto.com/specs/lexicon>
- Repository & records — <https://atproto.com/specs/repository>
- Record keys / **TID** structure — <https://atproto.com/specs/record-key>
- Blobs — <https://atproto.com/specs/blob>
- AT-URI — <https://atproto.com/specs/at-uri-scheme>

## Background: who writes into your repo?

In branch `b` you fetched records. Here is the uncomfortable question this
branch answers: **who put them there?**

- You did, through Leaflet or pckt or Sequoia — three tools with three
  different ideas of which optional fields to populate.
- A tool that didn't exist when `atmo` was written did, using a `content`
  block shape nobody has seen yet.
- A buggy client did, writing `publishedAt: null` for a whole afternoon.
- Someone hostile did, if they ever gain write access, with a 40 MB title and a
  `tags` array containing objects.

There is no schema enforcement at read time. The PDS stores what it is given.
So the question is never "is this record valid?" — it's **"what do I render if
it isn't?"**

`atmo` answers: _that one post is missing; the site builds_. A single bad
record must not take down a page, let alone a build. That posture inverts the
usual instinct — with an ORM, a missing column means a bug and you _want_ the
exception. Here, malformed input is a **normal operating condition**.

The cost is real and worth naming: a typo'd `publishedAt` makes a post silently
vanish. Branch `h` adds `atmo doctor`, which is where you _do_ want the loud
version.

## Guided tour of the diff (read in this order)

1. **`parseDocument`** — start at the two early returns. Those are the entire
   "required" set. Everything below them is defaulting.

2. **`contentMarkdown`** — the open-union probe. Note that it tries several
   known field names and then gives up _quietly_, because the fallback
   (`textContent`) is always there.

3. **`slugFrom`** — derives a URL slug from `path`, falling back to the rkey.
   Note the fallback-of-the-fallback: if slugifying the rkey somehow empties
   it, the raw rkey is used, because a document must always have an address.

4. **`belongsToPublication`** — four lines, three of which are exceptions. The
   deep dive below.

5. **`collectDocuments`** — parse, filter, sort. Read the comment on the sort;
   it contradicts something branch `b` told you, deliberately.

6. **`tests/document.test.ts`** — read the `it.each` blocks. The "survives a
   junk X" table and the "never throws" case are the specification.

## Deep dive: what is actually required?

Only two things:

```ts
if (record.rkey === "") return null;
const publishedAt = asDate(value["publishedAt"]);
if (publishedAt === null) return null;
```

Why those and nothing else?

**The rkey is the record's address.** Without it there is no stable identity,
no URL, and no way to refer to the thing. It comes from the AT-URI — the
envelope the PDS constructed — not from a field inside `value`, which the
author controls and can lie about.

**`publishedAt` is the ordering key and part of every URL.** A post with no
date can't be sorted, can't be paginated deterministically, and can't be given
a dated permalink. There is no sensible default: "now" would make the post jump
to the top of the feed on every build, and the epoch would bury it forever.

Everything else has an obvious degradation:

| Field         | Junk value            | Result                                   |
| ------------- | --------------------- | ---------------------------------------- |
| `title`       | `42`                  | `""` — an untitled post still renders    |
| `description` | `[]`                  | `""`                                     |
| `tags`        | `"not-a-list"`        | `[]`                                     |
| `tags`        | `["Ok", 3, "", "ok"]` | `[{Ok}]` — non-strings and dupes dropped |
| `path`        | `{nested: true}`      | slug falls back to the rkey              |
| `coverImage`  | `"nope"`              | `null` — no cover, not a crash           |
| `updatedAt`   | `"garbage"`           | falls back to `publishedAt`              |

The general rule: **require what you cannot invent; default everything you
can.** If you can think of a sane fallback, it isn't required.

## Deep dive: the ordering contract

Branch `b` sent `reverse=true` and said TID rkeys make that roughly
newest-first. This branch sorts again, by a different key:

```ts
documents.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
```

Both are correct, and they are answering different questions.

A **TID encodes creation time** — when the record was written to the repo.
`publishedAt` is a claim _inside_ the record about when the post was published.
Those diverge constantly:

- You backdate an essay to when you actually wrote it.
- You import ten years of archives on a Tuesday; every rkey says Tuesday.
- You write a draft in January and publish it in March (very much branch `i`'s
  world).

So:

> **Wire order is an optimization. Record order is the contract.**

`reverse=true` still earns its place — it decides _which_ records survive
`max_records`. Newest-first at the wire level means an over-cap repo keeps its
most recent thousand rather than its oldest thousand. But what the reader sees
is decided here, from the data.

There is a test that makes this explicit: two records where rkey order and
`publishedAt` order disagree, asserting the output follows `publishedAt`. If
someone ever "optimizes away" the redundant-looking sort, that test explains
why it isn't redundant.

## Deep dive: tolerate absence, reject contradiction

`belongsToPublication` is the most subtle function in the branch:

```ts
if (publicationRkey === "" || doc.site === "") return true;
const prefix = `at://${did}/site.standard.publication/`;
if (!doc.site.startsWith(prefix)) return true;
return doc.site.slice(prefix.length) === publicationRkey;
```

Three ways to be _kept_ and one way to be _excluded_. The asymmetry is the
point.

A document names its publication in `site`. A source pins one rkey — say
`self`. Now consider what shows up in a real repo:

| `site`                                | Kept?  | Why                                       |
| ------------------------------------- | ------ | ----------------------------------------- |
| `at://you/…publication/self`          | yes    | Claims this publication                   |
| `at://you/…publication/drafts`        | **no** | Claims a _different_ one, here            |
| _(absent)_                            | yes    | Written by a tool without this convention |
| `at://someone-else/…publication/self` | yes    | Not about this repo's partitions          |

The exclusion fires **only on a positive claim of a different publication in
the same repo.** That is what lets drafts live alongside posts: the drafts
claim `drafts`, so the `self`-pinned source skips them, and a `drafts`-pinned
source picks them up.

But a record with no `site` at all is _kept_, and this matters more than it
looks. Other tools write `site.standard.document` without mosaic-ish
publication conventions. Hiding a user's own writing because it lacks a field
your tool invented would be a bug that looks like data loss. **Absence of a
claim is not a claim of absence.**

## Design decisions & "why not X"

- **Why not validate with zod, like the config?** Because the failure modes are
  opposite. Config is written by the operator, and a mistake there should stop
  the build loudly — zod is perfect. Records are written by strangers, and a
  mistake should cost one post quietly. A schema validator's job is to reject;
  this parser's job is to salvage.
- **Why return `null` rather than throw-and-catch per record?** Exceptions for
  expected control flow are slow and easy to over-catch — one stray `try`
  around the loop and you lose the whole batch instead of one record. A
  nullable return makes "this one didn't work" ordinary.
- **Why derive `rkey` from the URI, and `slug` from a field?** Different jobs.
  The rkey is _identity_ and must come from the envelope. The slug is
  _presentation_ and may come from the payload — worst case it's ugly, and the
  fallback keeps it unique.
- **Why is `content` probed rather than typed?** It is an open union.
  Enumerating the block types that exist today guarantees breakage when the
  eleventh appears. Probing for what you understand and falling back to
  `textContent` means a future block type degrades to plain text instead of an
  empty page.
- **Why cap `slugify` at 80 characters?** Filesystem path limits, and a title
  that is a whole paragraph shouldn't become a directory name. The rkey
  fallback keeps collisions from being silent.

## Review questions

1. _Why is `updatedAt` allowed to default to `publishedAt`, but `publishedAt`
   isn't allowed to default at all?_ — "Never edited" is a real, correct
   meaning for a missing `updatedAt`. There is no equivalent true statement for
   a missing publication date; any default would be a fabrication that changes
   the reader's ordering.
2. _A record claims `at://did:plc:someone-else/site.standard.publication/self`
   and your source pins `self`. It is kept. Isn't that a bug?_ — No. That URI
   is about a different repo's partitioning and says nothing about where this
   record belongs here. The filter's job is to resolve _intra-repo_ ambiguity
   only.
3. _What is the cost of the tolerant posture, and where is it paid?_ — A
   malformed record vanishes with no user-visible signal. It's paid in branch
   `h`, where `doctor` reports records that were skipped and why.

## Exercises

1. **Break a field, keep the post.** Add a test putting an object in `title`.
   Confirm the document still parses. Now put junk in `publishedAt` and confirm
   it doesn't.
2. **Add a required field the wrong way.** Make `title` required by returning
   `null` when it's empty. Run the suite, then think about what an untitled but
   otherwise fine post looks like to its author. Revert.
3. **A future content block.** Write a record whose `content` is
   `{$type: "com.example.blocks.v2", chunks: [...]}`. Confirm it falls back to
   `textContent`. Then extend `contentMarkdown` to understand it, without
   breaking any existing test.
4. **Prove the ordering rule.** Construct three records where rkey order,
   `publishedAt` order, and `updatedAt` order all disagree. Assert the output
   order and explain in a comment why that's the right one.

## Verify it yourself

```bash
npm test -- document                 # 50 tests, most of them about failure
npm test                             # 98 total
```

## Watch & listen

- **Read a real record.** Open [pdsls.dev](https://pdsls.dev), find any
  `site.standard.document`, and compare its fields to `parseDocument`. Note how
  many of them are absent.
- ["Did Lexicon just accidentally solve the enterprise data problem?"](https://ionosphere.tv/talks)
  — Emily Gorcenski, ATmosphereConf. On Lexicon as a general data-modelling
  language — useful context for why open unions exist and why consumers must
  tolerate them.
- [standard.site](https://standard.site/) — the schema this branch parses.
  Short enough to read in full.

## Glossary

- **Tolerant parser** — one that salvages what it can and skips the rest,
  never raising on input shape.
- **Open union** — a lexicon field whose value may be any of an
  extensible set of types, including unknown ones.
- **Publication** — a `site.standard.publication` record; a document names its
  own in `site`.
- **Publication pin** — the rkey a source declares, partitioning one repo.
- **Envelope vs payload** — the PDS-constructed wrapper (`uri`, `cid`) vs the
  author-controlled record body.
- **Ordering contract** — display order comes from `publishedAt`, not from
  rkey or wire order.
