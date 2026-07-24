# mosaicat — a stacked-PR learning journey

This is a **guided course** disguised as a pull-request stack. It replays how
mosaicat grew from a plain Django blog into an ATProto-native personal site
whose content lives in the repos — one reviewable PR at a time.

You already write Python well. The goal here is twofold:

1. **Understand ATProto deeply** — not "what's a DID" trivia, but the actual
   mechanics: how identity resolves, how records and blobs move over XRPC, how
   OAuth is bound to a key with DPoP, how a quiet PDS works as a privacy
   boundary, and *why* the protocol is shaped the way it is.
2. **Sharpen your Python/Django** — each PR is chosen to also carry a
   non-obvious language or framework technique (state-only migrations,
   `transaction.on_commit`, dependency injection over settings singletons,
   DPoP/JWT crypto, cached adapters over hostile record input).

## How to take the course

Each PR is a branch stacked on the previous one. Review them **bottom-up, in
order** (1 → 10); each builds on the last.

- `main` — the clean starting tip: the security-review hardening pass
  (`f3088b6`). No ATProto code yet.
- `learn/base` — `main` plus the martor editor migration the bridge builds on,
  and this syllabus. Diff `main...learn/base` to see exactly that gap.
- `learn/01-atproto-bridge` … `learn/10-clean-slate` — the ten lessons.

For each PR:

1. **Read the lesson first** — `docs/learning/NN-*.md`. It states the learning
   objectives, gives the ATProto background you need, then walks you through
   the diff in reading order with the "why" behind each piece.
2. **Review the diff** as if it were a real PR. The lesson calls out what to
   look for and poses review questions (answers included, but try first).
3. **Do the exercises** — a mix of "spot the bug", "predict the behavior", and
   hands-on changes.
4. **Merge** into your journey branch and move on.

The lessons are *dense on purpose*. Read with the code open in a second pane.

## The map

| PR | Lesson | ATProto concepts | Python / Django craft |
|----|--------|------------------|-----------------------|
| 1 | [ATProto bridge](01-atproto-bridge.md) | XRPC, DID/handle/PDS resolution, records, blobs, `did:plc` vs `did:web`, AT-URIs | app layering, `transaction.on_commit`, network-mocked tests |
| 2 | [Reactions & comments](02-reactions.md) | `getPostThread`, the Constellation backlink index, AppViews vs indexes | tiered caching, graceful degradation, tolerant parsers |
| 3 | [Lexicon pages](03-lexicon-pages.md) | Lexicon schemas, NSIDs, TID rkey ordering, personal AppView pattern | request-time rendering, a template registry, custom filters |
| 4 | [0.2.0 craft (interlude)](04-hardening.md) | *(light)* bounded render-path latency | **state-only FK migration**, optional extras, CI matrices, packaging |
| 5 | [De-singletonize + preview](05-preview.md) | reading *any* actor's repo, DID-scoped caches, SSRF & the PDS | dependency injection vs settings singletons, throttling |
| 6 | [OAuth client](06-oauth.md) | ATProto OAuth: PAR, PKCE, **DPoP**, `private_key_jwt`, JWKS, token rotation | the `cryptography`/`PyJWT` stack, row-locked refresh |
| 7 | [The PDS-canonical read path](07-pds-canonical.md) | listRecords cursor walks, records as hostile input, publications partitioning a repo, blob serving | a cached adapter layer, dataclass views for templates, streaming proxies, degrade-don't-500 |
| 8 | [The writing desk](08-authoring.md) | record-level writes, TID rkeys, blobs + content addressing, drafts as records | staff-gated views outside the admin, capability-token previews, image pipelines |
| 9 | [The quiet repo](09-quiet-pds.md) | running a PDS nobody can reach, network isolation as the privacy boundary, PLC metadata | compose profiles, internal networks, env-driven settings, account bootstrap over the admin API |
| 10 | [The clean slate](10-clean-slate.md) | the repo as the only content store, deterministic publication uris | deleting a data layer, config-backed template context, docs as product surface |

## A 10-minute ATProto primer (read once, before PR 1)

ATProto (the **A**uthenticated **T**ransfer **Proto**col) is the protocol
underneath Bluesky, designed so your identity and data are portable across
apps and hosts. Five ideas carry almost everything in this course:

- **Identity is a DID.** Every account has a stable **DID** (Decentralized
  IDentifier), e.g. `did:plc:ewvi7...`. It never changes. Your **handle**
  (`alice.bsky.social`) is just a human-friendly, *reassignable* pointer to
  the DID — which is exactly why later PRs are careful to key everything on the
  DID, not the handle. See <https://atproto.com/specs/did> and
  <https://atproto.com/specs/handle>.
- **Data lives in a repo on a PDS.** Your **PDS** (Personal Data Server) hosts
  your **repository**: a signed key-value store of **records**, grouped into
  **collections** named by **NSID** (e.g. `app.bsky.feed.post`). Each record
  has a **record key** (**rkey**); many are **TID**s — timestamp-ordered IDs,
  so "sort by rkey descending" means "newest first". See
  <https://atproto.com/specs/repository> and
  <https://atproto.com/specs/record-key>.
- **Everything is addressable by AT-URI.** `at://<did>/<collection>/<rkey>`
  uniquely names a record anywhere in the network.
  See <https://atproto.com/specs/at-uri-scheme>.
- **The wire protocol is XRPC.** Plain HTTP: `GET/POST` to
  `/xrpc/<nsid>` (e.g. `com.atproto.repo.createRecord`). Schemas for methods
  and records are declared in **Lexicon**.
  See <https://atproto.com/specs/xrpc> and <https://atproto.com/specs/lexicon>.
- **Reading is open; writing is authenticated.** Anyone can read public
  records; writing to a repo needs auth (an app password early on, full OAuth
  later). This asymmetry is why the "read side" (PRs 1–5) is simpler than the
  "write side" (PR 6+).

Official entry points worth bookmarking:
<https://atproto.com/guides/overview>, the lexicon reference at
<https://docs.bsky.app/docs/category/http-reference>, and the spec index at
<https://atproto.com/specs/atp>.

> Each lesson repeats the exact links you need for *that* PR under a
> **Grounding: official docs** heading, so you can always trace a claim back to
> the source.

## Talks, podcasts & further reading

Every lesson ends with a **Watch & listen** section pointing at material for
*that* PR. These are the course-wide ones — useful before you start, and worth
returning to at the end when you can follow them as a practitioner.

**Video & audio**

- [ATmosphereConf talk archive](https://ionosphere.tv/talks) — the single best
  resource here. Conference talks transcribed with timestamps and searchable by
  concept, so you can jump to "DPoP" or "lexicon" instead of scrubbing.
  Companion sites: [atmosphereconf.org](https://atmosphereconf.org/) and the
  [Seattle 2025 playlist](https://www.youtube.com/playlist?list=PLyIg0j_mbb2tVegEMBg5ke2Z-1ALksU-I).
- [AT Protocol Community channel](https://www.youtube.com/@atprotocoldev) —
  meetup recordings and protocol talks.
- [SE Radio 651: Paul Frazee on Bluesky and the AT Protocol](https://se-radio.net/2025/01/se-radio-651-paul-frazee-on-bluesky-and-the-at-protocol/)
  — an hour with a protocol architect; the best pre-PR-1 listen.
- [Mitigating Geopolitical Risks with Local-First Software and atproto](https://martin.kleppmann.com/2026/03/17/qcon-keynote-geopolitical-risk.html)
  — Martin Kleppmann, QCon London 2026 (video via InfoQ). Best watched *after*
  PR 10, when the argument is one you've implemented.

**Written**

- [Introduction to AT Protocol](https://mackuba.eu/2025/08/20/introduction-to-atproto/)
  — mackuba. The clearest map of PDS / relay / AppView / firehose.
- [Bluesky and the AT Protocol: Usable Decentralized Social Media](https://arxiv.org/abs/2402.03239)
  — Kleppmann et al.; the peer-reviewed architecture paper.
- [Jetstream: Shrinking the AT Proto Firehose by >99%](https://jazco.dev/2024/09/24/jetstream/)
  — Jaz. Background for PR 7's consumer.
- [You can just hack on ATProto](https://vickiboykis.com/2025/01/23/you-can-just-hack-on-atproto/)
  — Vicki Boykis. Short, and a good antidote if the protocol feels intimidating.

**Tools to keep open**

- [pdsls.dev](https://pdsls.dev) — browse any repo's records by handle. You will
  use this constantly from PR 1 onward.
- [plc.directory](https://plc.directory) — read a real DID document.
- [Constellation](https://constellation.microcosm.blue) — the backlink index PR 2
  queries.

> Links rot. Each entry names its **title and speaker/author** as well as its
> URL, so anything that moves stays findable by search.

## A note on the lesson structure

Every lesson follows the same shape, so you can navigate them consistently:
one-sentence version → learning objectives → grounding links → background →
guided tour of the diff → deep dive(s) → design decisions → review questions →
exercises → verify → watch & listen → glossary.

**Commits are referenced relatively, never by hash.** Header **Diff:** lines
give a branch range (`learn/A...learn/B`); lessons covering several commits
(PRs 4 and 5) label them `~N`, meaning `<that branch>~N`. This is deliberate —
an earlier draft of these lessons pinned raw hashes, the stack was rebased, and
every single reference died. Relative refs survive a restack; hashes do not.
The only hash quoted anywhere is `f3088b6` on `main`, which is not part of the
rebased stack.

To see the commits behind any lesson with their current hashes:

```bash
git log --oneline learn/<previous>..learn/<this-one>
```
