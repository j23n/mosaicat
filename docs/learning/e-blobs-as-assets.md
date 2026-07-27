# e — Blobs as assets

> **Stack:** e/j · **base:** `learn/d-emit-a-site`
> **Diff:** `learn/d-emit-a-site...learn/e-blobs-as-assets` ·
> **What it adds:** images. `pull` downloads every blob a document references
> into a CID-keyed cache; `build` copies them into `dist/assets/blobs/` and
> rewrites the URLs. After this branch the rendered site has no runtime
> dependency on the PDS at all.

## The one-sentence version

A blob's CID is a hash of its bytes, so **the key is the content** — which
makes the blob cache the only cache in the tool that can never be stale, needs
no TTL, and requires no invalidation logic: if the file is there, it is right.

## Learning objectives

**ATProto**

- `com.atproto.sync.getBlob` and how a blob is addressed: `did` + `cid`.
- **Content addressing**: identical bytes produce an identical CID in any repo,
  and a CID's content can never change.
- The three places a document can reference an image, and why a renderer has to
  look in all of them.

**Craft**

- A cache whose correctness is a property of the key, not of a policy.
- Keeping the `pull`/`build` wall intact when a new kind of I/O appears.
- Rewriting URLs _after_ sanitizing, and why the order is a security decision.
- Degrading a missing asset to a broken `<img>` instead of a failed build.

## Grounding: official docs

- Blobs — <https://atproto.com/specs/blob>
- `com.atproto.sync.getBlob` —
  <https://docs.bsky.app/docs/category/http-reference>
- CID / multiformats — <https://github.com/multiformats/cid>
- `loading="lazy"` —
  <https://developer.mozilla.org/en-US/docs/Web/HTML/Element/img#loading>

## Background: what a blob is, and why the cache is easy

Records are JSON and small. Images are neither, so ATProto keeps them
**outside** the record: you upload the bytes, the PDS returns a **blob ref**,
and the record embeds the ref rather than the data.

The ref is a **CID** — a content identifier, which is a hash of the bytes
wrapped with a little metadata about the hash function. Two consequences carry
this whole branch:

1. **The same bytes always yield the same CID**, in any repo, on any PDS.
2. **A given CID's content can never change.** Change one byte and it is a
   different CID.

Point 2 is the useful one. Every other cache in this tool has to answer "is
this still true?" — the record cache is versioned, branch `h` adds staleness
guards. The blob cache never asks:

```ts
for (const name of existing) {
  if (name.startsWith(`${cid}.`)) return { cid, mimeType, bytes: 0 };
}
```

If a file for that CID exists, it is correct. Not _probably_ correct, not
_correct until the TTL expires_ — correct, permanently. **When your cache key
is a hash of the value, invalidation is not a hard problem; it's not a problem
at all.**

The payoff for the site is bigger than it looks. Before this branch, every
`<img>` pointed at the PDS, so a reader's page load depended on that server
being up and fast, and every view leaked the reader's IP to it. After this
branch the images are files next to the HTML. **The rendered site no longer
depends on the PDS at runtime in any way** — which is the whole argument for
the static approach, made concrete.

## Guided tour of the diff (read in this order)

1. **`src/blob.ts`** — read `documentCids` and `contentCids` first (where
   images hide), then `fetchBlob` (the cache check comes _before_ the network),
   then `rewriteBlobUrls`.

2. **`src/cache.ts`** — `blobs: BlobRecord[]` is now part of a source's cache,
   and `CACHE_VERSION` went to `2`. That bump is the mechanism from branch `b`
   doing its job: an old cache is now structurally different, and is treated as
   absent rather than misread.

3. **`src/pull.ts`** — blobs are downloaded here, in the only command allowed
   to touch the network. Note that documents are parsed during `pull` purely to
   _discover_ CIDs; the parse result is thrown away and redone in `build`.

4. **`src/build.ts`** — copies from cache to `dist`. `build` still has no
   network, which is the point.

5. **`src/site.ts`** — `rewriteBlobUrls` wraps `renderBody`, so rewriting
   happens on already-sanitized HTML.

## Deep dive: three places an image hides

There is no single "images" field you can rely on, because the tools writing
`site.standard.document` don't agree:

```ts
export function documentCids(doc: Document): string[] {
  const cids = new Set<string>();
  if (doc.cover !== null) cids.add(doc.cover.cid); // the coverImage field
  for (const cid of contentCids(doc.content)) cids.add(cid); // getBlob URLs in the body
  return [...cids];
}
```

- **`coverImage`** — a blob ref in a known field. Easy, and branch `c` already
  parses it tolerantly.
- **`getBlob` URLs in the body** — an editor that uploads an image inline
  writes a full URL into the markdown. There is no field listing them; you have
  to read the text.
- **An `images` array** — some writers carry an explicit list of refs so the
  PDS doesn't garbage-collect blobs no record points at. Worth knowing about
  even though the body scan already catches those CIDs.

The body scan is a regex over the _source_, which is unusual and worth
defending: parsing markdown to an AST just to find URLs would mean rendering
twice, and the CID is a well-delimited token in a URL that is itself a
well-known shape. A false positive costs one wasted `getBlob` that returns 404
and is skipped. A false negative costs one un-cached image that still loads
from the PDS. Neither breaks anything — which is what makes the cheap approach
acceptable here and wouldn't if the failure modes were worse.

Deduplication via `Set` matters more than it looks: a cover image reused in the
body is one CID, one download, one file.

## Deep dive: rewrite after sanitize

```ts
const html = rewriteBlobUrls(renderBody(doc.content, doc.isMarkdown), mimeByCid);
```

The rewrite runs on rendered, sanitized HTML. Two other orderings are
available and both are worse:

**Rewriting the markdown source first** would mean the sanitizer sees URLs the
rewrite invented. That is survivable, but it puts a transformation _upstream_
of the security boundary — and anything upstream of a sanitizer is something
the sanitizer has to be correct about.

**Rewriting after emission** — i.e. post-processing the final HTML file —
would work but reintroduces the same problem at a worse moment: you would be
editing markup that has already been declared safe, with a regex, at a point
where nothing checks you again.

Running _between_ rendering and output means the rewrite only ever replaces the
value of an attribute the sanitizer already approved, and can only change it to
a path this code constructed. Note also that a CID the cache doesn't know is
**left alone** rather than dropped — that image keeps loading from the PDS,
degraded but working, which is the same posture as everything else in the tool.

## Deep dive: which failures are survivable

Blobs are where "degrade, don't fail" gets its clearest test, because a missing
image is genuinely minor:

| Failure                            | Handled where                     | Result                                         |
| ---------------------------------- | --------------------------------- | ---------------------------------------------- |
| Blob 404s                          | `fetchBlob` returns `null`        | No local file; `<img>` still points at the PDS |
| Network error mid-download         | `catch` → `null`                  | Same                                           |
| Untrusted PDS on a private address | `assertPublicUrl` throws → `null` | Blob skipped                                   |
| Recorded in cache, file deleted    | `build`'s `try/catch` around `cp` | Blob not emitted                               |
| Unknown mime type                  | `extensionFor` → `.bin`           | File saved, served with a generic type         |

Contrast with branch `b`, where a failing _source_ aborts the whole pull. The
difference is proportionality: a missing source means a whole section of the
site silently vanishes, which the reader cannot detect. A missing image is
visible, local, and obvious. **Match the severity of the response to the
severity of what was lost.**

## Design decisions & "why not X"

- **Why download during `pull` rather than `build`?** The wall. `build` must
  stay a pure function of the cache — branch `h` depends on being able to
  produce and inspect a complete site with the network unplugged.
- **Why store blobs as `<cid>.<ext>` rather than by original filename?** The
  CID is the identity; the filename in a record is decoration and may collide,
  be absent, or contain path separators. The extension is appended only so
  static hosts guess the content type correctly.
- **Why parse documents twice — once in `pull`, once in `build`?** `pull`
  parses only to discover CIDs and discards the result. Caching the parse would
  make the cache go stale on any code change, which branch `b` established as
  the thing to avoid. Parsing is microseconds; the download is what's
  expensive.
- **Why not resize or re-encode images?** It's tempting, and it's a real
  feature. It also means a build's output depends on which version of an image
  library was installed, which breaks the determinism branch `h` needs. If you
  add it, make the parameters explicit config and the output part of the cache
  key.
- **Why is `loading="lazy"` forced onto every `<img>`?** It costs nothing, and
  a document from someone else's editor will not have thought about it.

## Review questions

1. _Every other cache here needs a version or a TTL. Why doesn't this one?_ —
   Because the key is a hash of the value. "Has the content changed?" cannot be
   true for a fixed CID, so there is no question to answer.
2. _A CID appears in a body but was never downloaded. What does the reader
   see?_ — The original `getBlob` URL, untouched, so the image still loads from
   the PDS. Degraded (a runtime dependency reappears for that one image) but
   not broken.
3. _Why is `CACHE_VERSION` bumped in this branch?_ — The on-disk shape gained a
   `blobs` field. Without the bump, a v1 cache would be read as a v2 cache with
   `blobs` undefined, and the code would have to defend against that shape
   forever. Bumping makes the old cache simply _absent_.

## Exercises

1. **Watch the cache work.** Pull a repo with images, note the download count,
   then delete `.atmo/cache/*.json` (but _not_ `.atmo/cache/blobs/`) and pull
   again. Why is the second run's blob count the same but its network traffic
   near zero?
2. **Corrupt a blob.** Overwrite a cached blob file with garbage and rebuild.
   The build succeeds and the image is broken. Is that the right call? Argue
   the other side, then look at what verifying CIDs would cost.
3. **Add the `images` array.** Extend `documentCids` to read an `images` field
   of blob refs. Write the test first, using a record where the array contains
   a CID the body does _not_ mention.
4. **Break the ordering.** Move `rewriteBlobUrls` to run before `renderBody`.
   Everything still passes. Explain what you gave up, and write a test that
   would catch it.

## Verify it yourself

```bash
npm test -- blob
npm run atmo -- pull && npm run atmo -- build
ls dist/assets/blobs/
grep -o 'src="[^"]*"' dist/posts/*/index.html | head
```

Every `src` should be a local path. If one still points at a PDS, that CID
wasn't downloaded — check the pull output.

## Watch & listen

- [The blob spec](https://atproto.com/specs/blob) — short, and the upload/ref
  split is the part worth internalising.
- [CID documentation](https://github.com/multiformats/cid) — what is actually
  inside the string, and why it is self-describing.
- Try it: open a `site.standard.document` on [pdsls.dev](https://pdsls.dev) and
  find a blob ref. Fetch it yourself with
  `curl "<pds>/xrpc/com.atproto.sync.getBlob?did=<did>&cid=<cid>" -o out.jpg`.

## Glossary

- **Blob** — binary data stored outside a record, referenced by CID.
- **CID** — content identifier; a self-describing hash of the bytes.
- **Content addressing** — naming data by its hash, so the name proves the
  content.
- **Blob ref** — the `{ref: {$link}, mimeType, size}` object inside a record.
- **`getBlob`** — the unauthenticated XRPC method serving blob bytes.
