# i — Private by capability

> **Stack:** i/j · **base:** `learn/h-builds-you-can-trust`
> **Diff:** `learn/h-builds-you-can-trust...learn/i-private-by-capability` ·
> **What it adds:** private posts. A source marked `visibility = "encrypted"`
> is rendered, encrypted with **age**, and written to paths derived by HMAC —
> unlisted, unguessable, and unreadable without the passphrase.

## The one-sentence version

Two independent layers — **a URL nobody can find** and **a payload nobody can
read** — protect content that is nonetheless sitting on the public web, using
a vetted encryption library on both sides so that _no cryptography is written
in this project at all_.

## Learning objectives

**Craft / security**

- **Not rolling your own**: what that actually means in practice, and where the
  line is between "using a primitive" and "designing a scheme".
- Why one library on both sides removes the failure mode that kills hand-rolled
  crypto — the interop seam.
- **Capability URLs**: possession of an unguessable path _is_ the
  authorisation, and the specific ways such a URL leaks.
- Key wrapping: one expensive KDF per session instead of one per file.
- Stating a threat model precisely, including what it does _not_ cover.
- Secrets from the environment, never from config.

**ATProto**

- A source whose identity cannot be resolved, only configured — the
  `did` + `pds_url` pair from branch `a`, finally used for its real purpose.

## Grounding: official docs

- age — <https://age-encryption.org/> · spec —
  <https://github.com/C2SP/C2SP/blob/main/age.md>
- `age-encryption` (typage), the TS implementation used here —
  <https://github.com/FiloSottile/typage>
- scrypt — RFC 7914, <https://www.rfc-editor.org/rfc/rfc7914>
- HMAC — RFC 2104, <https://www.rfc-editor.org/rfc/rfc2104>
- WebCrypto `SubtleCrypto` —
  <https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto>
- W3C, _Good Practices for Capability URLs_ —
  <https://www.w3.org/TR/capability-urls/>
- `Referrer-Policy` —
  <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy>
- StatiCrypt and PageCrypt, the prior art —
  <https://github.com/robinmoisson/staticrypt>

## Background: why the protocol cannot help you

State the constraint plainly, because everything follows from it:

> **ATProto has no private records.** `listRecords`, `getRecord`, `getRepo` and
> `getBlob` require no authentication. If someone can reach your PDS and knows
> your DID, they can read everything in it.

There is no visibility field, no permission bit, no followers-only. The
protocol is built for public broadcast — branch `b` depended on exactly that
openness to read a repo with no credentials. So "private posts" cannot be a
protocol feature, and pretending otherwise would be the dangerous kind of
wrong.

What _is_ available is **topology and cryptography**, and they protect
different things:

|                              | Threat                                                             | Defence                                        |
| ---------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| **The store** (a PDS)        | `listRecords` enumeration; relays replicate public repos by design | Unreachability — a PDS with no route in        |
| **The artifact** (your site) | Someone finding the URL                                            | An unguessable path, with encryption behind it |

Neither covers the other. Encryption does nothing for the store, because
ciphertext in a public repo is still enumerable and permanently downloadable.
Unreachability does nothing for the artifact, because you are publishing it.
**You need both**, which is why the private source in `atmo.example.toml` is
configured with an explicit `did` + `pds_url` — it points at a PDS on a network
the internet cannot route to, and its identity therefore cannot be resolved,
only declared.

That has a consequence worth planning for: **a build including a private source
must run somewhere that can reach that network.** Ordinary CI cannot. In
practice you build locally — which is also where you want the passphrase.

## Guided tour of the diff (read in this order)

1. **`src/crypto.ts`** — read the module docstring first; it is the design
   rationale. Then `siteKeysFrom` (wrapping), then `derivePath` (HMAC), then
   note how little else is there.

2. **`src/private.ts`** — `loadSiteKeys` (why the identity persists), then
   `emitPrivate` and the three kinds of file it writes.

3. **`src/client/decrypt.ts`** — the browser half, importing the _same_
   library. Compare `derivePath` here with the one in `crypto.ts`: same
   algorithm, same inputs, no format negotiated between them.

4. **`src/templates/private.eta`** — the entry shell. Note how little it
   contains.

5. **`tests/private.test.ts`** — read "writes no plaintext of a private post
   anywhere in the output". It walks the entire `dist/` tree.

## Deep dive: not rolling your own, precisely

"Don't roll your own crypto" is repeated until it stops meaning anything. Here
is the operational version.

**What this project does not write:** any cipher, any KDF, any authenticated
encryption construction, any key agreement, and — crucially — **any ciphertext
format**. Content encryption is [age](https://age-encryption.org/), a specified
and reviewed format, via `age-encryption`, a TypeScript implementation by age's
own author that runs in Node _and_ in the browser.

**What it does write:** `derivePath`, an HMAC-SHA256 over a label. That is
using a standard primitive exactly as intended, with no novel composition. And
base32, which is an encoding.

The distinction is whether you are _inventing a construction_. Choosing
"HMAC this label to get a filename" is not cryptographic design; choosing
"encrypt with AES-CTR and append a SHA-256 for integrity" is, and it's wrong.

**The seam that matters most is language.** Consider the alternative stack: a
Go binary encrypts, JavaScript decrypts. Now two codebases must agree on nonce
length, KDF parameters, header framing, and version bytes — and the _only_
place that agreement is written down is your own head. That gap is where real
systems fail. Using one library on both sides means there is nothing to agree
on: both sides say "age file", and age already specifies the rest.

This is the concrete reason branch `a` chose TypeScript over Go despite Go's
nicer single-binary distribution. It was never really about the language.

Prior art worth knowing: **StatiCrypt** and **PageCrypt** do password-protected
static HTML already. If your needs stop at "one password, one page", use one of
them and write nothing. This branch goes further only because derived paths and
an encrypted manifest don't fit their whole-page model.

## Deep dive: wrap the key, not every file

The obvious design — passphrase-encrypt each post — is wrong for a reason you
can measure. age's passphrase mode runs **scrypt**, deliberately slow. At the
work factor used here that is roughly a second. Per file.

```
passphrase-per-file:   20 posts → 20 × scrypt on build,  scrypt on EVERY page view
wrapped identity:      20 posts →  1 × scrypt on build,  scrypt once per session
```

Measured on this machine: 20 posts encrypt to a recipient in **119 ms** and
decrypt in **30 ms**, while one passphrase wrap costs **830 ms**. A reader
waiting a second per page would simply stop reading.

So:

```
site identity   a random age X25519 identity, persisted between builds
every payload   encrypted TO that identity        (fast, no KDF)
the identity    wrapped under the passphrase      (one scrypt, once)
```

The browser unwraps the identity once, stores it in `sessionStorage` (not
`localStorage` — it should not outlive the tab), and every subsequent page is
milliseconds. This is standard key-wrapping, and age supports it directly
because it is how age is meant to be used.

**The work factor is raised above age's default on purpose.** Normally you tune
a KDF against an attacker who must first steal a file. Here the file is
_published_: unlimited offline attempts, no rate limiting, forever. Roughly one
second on unlock is a price a reader pays once and an attacker pays per guess.

**Why the identity persists in a file.** A fresh identity per build would
change every derived path on every build, breaking links you have already
shared. `.atmo/identity` holds the secret half, is gitignored, is written
`0600`, and never enters `dist/`. There is a test asserting that last part.

## Deep dive: no plaintext index exists

The entry page at `/private/` is public, crawlable, and archivable. If it
listed the private post URLs, archiving it would hand over every capability at
once — and unguessable paths would be pointless.

So it contains **no URLs at all**. Just a prompt and the passphrase-wrapped
identity. The chain is:

```
/private/            → prompt; unwrap identity            (one scrypt)
HMAC(identity,"index")→ /p/<derived>/payload.age          encrypted manifest
HMAC(identity,"path:<rkey>") → /p/<derived>/payload.age   one encrypted post
```

Every location is computed _from the unwrapped identity_, so the URLs come into
existence only after a successful unlock. There is no manifest URL to leak,
because the manifest's own path is derived too.

Three supporting details:

- **Every post's `index.html` shell is byte-identical.** It carries no title,
  no date, no length. Only the sibling `payload.age` differs, and it's
  ciphertext. A test asserts two different posts produce identical shells.
- **`noindex` plus `Referrer-Policy: no-referrer`** on every private page. The
  referrer one is load-bearing: without it, a single outbound link from a
  private post hands the capability URL to whoever runs the destination. Branch
  `d`'s `rel="noopener noreferrer"` on body links was the first half of this.
- **Reactions are forced off.** A private page must never call an AppView; the
  request itself would tell a third party the URL exists.

`robots.txt` has disallowed `/p/` since branch `d` — written before there was
anything there, because remembering later is exactly what people don't do.

## The threat model, stated honestly

**Protects against:** casual discovery, search indexing, crawling, enumeration
(there is no listing endpoint), and anyone who obtains a URL but not the
passphrase.

**Does not protect against:**

- **A weak passphrase.** The ciphertext is public and attacked offline forever.
  Use a diceware phrase; a memorable 8-character password is not meaningfully
  encrypted.
- **Permanence.** Published once is published. Rotating the passphrase changes
  every path and re-encrypts everything, but anything already fetched or
  archived stays readable under the old passphrase.
- **Metadata.** The number of private posts is visible in the manifest's size,
  and the count of `/p/` directories is visible to anyone who can list your
  hosting.
- **Leaked URLs.** Link previews are the practical hazard — paste a capability
  URL into Slack, Discord or iMessage and their unfurlers fetch it immediately.
  Encryption is what makes that survivable rather than fatal.

If disclosure would genuinely harm someone, this is not the mechanism. It is
built for "a few people read my half-finished thoughts", and for that it is
proportionate.

## Design decisions & "why not X"

- **Why is the passphrase an environment variable, not config?** Config gets
  committed. `ATMO_PASSPHRASE` is read at build time and never persisted, and
  the build fails loudly rather than silently emitting plaintext if it's
  missing.
- **Why encrypt rendered HTML rather than the markdown?** So the payload goes
  through the same sanitizer as every public page. The browser then renders
  already-trusted markup and never has to sanitize anything — which is why
  `decrypt.ts` may use `innerHTML` where branch `g`'s script may not.
- **Why HMAC for paths rather than a random UUID per post?** Determinism.
  Random paths would need a stored mapping, which is another secret file to
  keep in sync. Derived paths are recomputable from the identity by both the
  build and the browser, with no shared state at all.
- **Why 16 base32 characters?** ~80 bits, which is far beyond guessable while
  keeping the URL short enough to paste. The full HMAC would be 52 characters
  and buy nothing.
- **Why `sessionStorage` and not `localStorage`?** The identity should not
  outlive the tab. A shared or borrowed machine shouldn't keep the key.
- **Why not just one PDS with encrypted records in it?** Because a public repo
  is enumerable _by protocol_: `listRecords` hands over the existence, size and
  timestamp of every private post, and relays replicate it. Ciphertext there is
  strictly worse than an unlisted file on your own host.

## Review questions

1. _Encryption and unguessable paths both protect the posts. Why keep both?_ —
   They fail differently. A leaked URL still needs the passphrase; a guessed
   passphrase still needs the URLs. Removing either makes a single mistake
   fatal.
2. _Why is the identity wrapped under the passphrase rather than posts being
   encrypted with it directly?_ — scrypt is deliberately slow, and
   passphrase-per-file means paying it per page view. Wrapping pays it once per
   session.
3. _What does the entry page reveal to someone who archives it?_ — That private
   posts exist, and the wrapped identity. Nothing else: no URLs, no titles, no
   count. The wrapped identity is exactly as strong as the passphrase.

## Exercises

1. **Verify the claim.** Run the private build, then `grep -r "your secret
text" dist/`. Nothing. Now decrypt a payload by hand with the `age` CLI and
   the identity file.
2. **Feel the work factor.** Drop `SCRYPT_WORK_FACTOR` to 10, rebuild, and time
   the unlock. Then reason about how many guesses per second an attacker gets
   at each setting.
3. **Rotate.** Change the passphrase and rebuild. Which files change? What
   happens to a URL you had already shared, and what happens to a copy someone
   already downloaded?
4. **Leak it deliberately.** Put an outbound `<a>` in a private post, remove
   the referrer meta, and watch the destination's logs. Put it back.
5. **Argue the simpler design.** Would StatiCrypt over the whole `/private/`
   tree be enough for you? What exactly do derived paths buy that a single
   password-protected index doesn't?

## Verify it yourself

```bash
npm test -- private          # ~25s; scrypt is supposed to be slow

export ATMO_PASSPHRASE='correct horse battery staple'
npm run atmo -- build
find dist/p -type f | head
grep -r "something only in a private post" dist/ || echo "no plaintext ✓"
```

## Watch & listen

- **"Protocol composition: extending atproto for private data"** — Rashid Aziz,
  ATmosphereConf Seattle 2025. Directly on what the protocol doesn't give you.
  Find it at [ionosphere.tv/talks](https://ionosphere.tv/talks).
- [Encryption for private content](https://github.com/bluesky-social/atproto/discussions/121)
  — the long upstream thread on why "just encrypt it" keeps not being the
  answer at protocol level.
- [W3C, Good Practices for Capability URLs](https://www.w3.org/TR/capability-urls/)
  — short, and the leak-vector list is the one to internalise.
- [The age spec](https://github.com/C2SP/C2SP/blob/main/age.md) — readable in a
  sitting, and a good example of what a small, well-scoped format looks like.

## Glossary

- **age** — a small, specified file-encryption format.
- **Identity / recipient** — age's private and public halves.
- **Key wrapping** — encrypting a key under a passphrase so the slow KDF runs
  once.
- **scrypt work factor** — the deliberate cost per passphrase guess.
- **Capability URL** — a URL whose possession is the authorisation.
- **Derived path** — a location computed by HMAC, so it needs no stored
  mapping.
- **Threat model** — the written statement of what you are and are not
  defending against.
