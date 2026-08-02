# atmo — a stacked-PR learning journey

This is a **guided course** disguised as a pull-request stack. It builds
`atmo` — a static site generator for an ATProto repo — one reviewable branch at
a time, from an empty repository to a shipped CLI.

You already write code well. The goal is twofold:

1. **Understand ATProto by consuming it.** Not "what's a DID" trivia — the
   actual mechanics of resolving an identity, walking a repo, treating records
   as untrusted input, addressing blobs by content hash, and reading lexicons
   other people designed.
2. **Learn the craft of a build tool.** Tolerant parsers, golden-file tests,
   caches whose correctness you can state in one sentence, builds that refuse
   to ship bad output, and knowing when _not_ to write code — including crypto.

## How to take the course

Each branch is stacked on the previous one. Review them **bottom-up, in order**
(a → j).

- `main` — an empty repository. Nothing but a README and a licence.
- `learn/a-skeleton` … `learn/j-ship-it` — the ten lessons.

For each:

1. **Read the lesson first** — `docs/learning/<letter>-*.md`.
2. **Review the diff** as a real PR. The lesson says what to look for.
3. **Do the exercises.**
4. **Merge into your journey branch** and move on.

Every branch ends green: the tool builds, the tests pass, and whatever the
lesson promised actually runs.

## Before you start: get some content into a repo

`atmo` **never writes to your repo.** It only renders. So you need records to
render, and you get them the same way any other reader would — from an app that
already writes `site.standard.document`:

- **[Leaflet](https://leaflet.pub)**, **pckt**, or **Offprint** — hosted
  editors, and the originators of the lexicon. Write a post in a browser.
- **[Sequoia](https://sequoia.pub/quickstart/)** — a CLI that publishes an
  existing markdown blog to your PDS. Works with Hugo, Astro, 11ty, Zola.

This is the first design decision of the course and it's worth naming: **we are
not building an editor.** Authoring is solved by several tools that all write
the same lexicon, so the only part worth owning is the rendering.

## The map

|     | Branch                    | Adds                         | ATProto                                                   | Craft                                                               |
| --- | ------------------------- | ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| a   | [skeleton](a-skeleton.md) | project, CLI, config, CI     | the primer                                                | config as the whole public surface; failing at load, not at runtime |
| b   | read-a-repo               | `atmo pull`                  | handle→DID→PDS, `listRecords` cursor walks, AT-URIs, TIDs | SSRF-safe fetching, timeouts, fixture-based network tests           |
| c   | records-are-hostile       | typed `Document` model       | `site.standard.document`, publications, ordering          | tolerant parsing, fuzz + golden tests                               |
| d   | emit-a-site               | `atmo build` → `dist/`       | _(light)_                                                 | SSG core, routes-as-paths, template registry by NSID                |
| e   | blobs-as-assets           | local images                 | `getBlob`, CIDs, content addressing                       | why a CID-keyed cache never needs invalidating                      |
| f   | personal-appview          | multi-source, any collection | lexicons you didn't write; NSID as contract               | config-driven pipelines, generic fallback rendering                 |
| g   | reactions-in-browser      | live comments                | AppView vs backlink index                                 | progressive enhancement, CORS, browser tests                        |
| h   | builds-you-can-trust      | cache, guards, `atmo doctor` | PDS availability, honestly                                | build-failure taxonomy; why a static build is _less_ forgiving      |
| i   | private-by-capability     | encrypted private posts      | a source with no public identity                          | using vetted crypto; capability URLs; stating a threat model        |
| j   | ship-it                   | packaging, action, docs      | —                                                         | distribution, docs as product surface                               |

## A 10-minute ATProto primer (read once, before `b`)

ATProto (the **A**uthenticated **T**ransfer **Proto**col) is the protocol under
Bluesky, designed so identity and data are portable across apps and hosts. Five
ideas carry almost everything here:

- **Identity is a DID.** Every account has a stable **DID**
  (`did:plc:ewvi7…`). It never changes. A **handle**
  (`alice.bsky.social`) is a human-friendly, _reassignable_ pointer to it —
  which is why caches key on the DID. See
  <https://atproto.com/specs/did> and <https://atproto.com/specs/handle>.
- **Data lives in a repo on a PDS.** Your **PDS** (Personal Data Server) hosts
  your **repository**: a signed store of **records** grouped into
  **collections** named by **NSID** (`site.standard.document`). Records have a
  **record key** (**rkey**), often a **TID** — a timestamp-ordered id. See
  <https://atproto.com/specs/repository> and
  <https://atproto.com/specs/record-key>.
- **Everything is addressable by AT-URI**: `at://<did>/<collection>/<rkey>`.
  See <https://atproto.com/specs/at-uri-scheme>.
- **The wire protocol is XRPC** — plain HTTP to `/xrpc/<nsid>`. Schemas are
  declared in **Lexicon**. See <https://atproto.com/specs/xrpc> and
  <https://atproto.com/specs/lexicon>.
- **Reading is open; writing is authenticated.** Anyone can read public records
  with no credentials. `atmo` only ever reads — which is why it needs no auth
  at all, and why it can render _anyone's_ site.

The lexicon this course renders is **standard.site**
(<https://standard.site/>) — `site.standard.publication` and
`site.standard.document`, shared by Leaflet, pckt, Offprint and others.

## Talks, podcasts & further reading

Each lesson ends with a **Watch & listen** section for that branch. These are
the course-wide ones.

- [ATmosphereConf talk archive](https://ionosphere.tv/talks) — conference talks
  with searchable transcripts. The best single resource here. Also
  [atmosphereconf.org](https://atmosphereconf.org/) and the
  [Seattle 2025 playlist](https://www.youtube.com/playlist?list=PLyIg0j_mbb2tVegEMBg5ke2Z-1ALksU-I).
- [SE Radio 651: Paul Frazee on Bluesky and the AT Protocol](https://se-radio.net/2025/01/se-radio-651-paul-frazee-on-bluesky-and-the-at-protocol/)
  — an hour with a protocol architect; the best listen before branch `b`.
- [Introduction to AT Protocol](https://mackuba.eu/2025/08/20/introduction-to-atproto/)
  — mackuba. The clearest written map of PDS / relay / AppView.
- [Bluesky and the AT Protocol: Usable Decentralized Social Media](https://arxiv.org/abs/2402.03239)
  — Kleppmann et al.; the peer-reviewed architecture paper.

**Tools to keep open:** [pdsls.dev](https://pdsls.dev) browses any repo by
handle — you will use it constantly. [plc.directory](https://plc.directory)
serves real DID documents.

## Conventions

Every lesson has the same shape: one-sentence version → learning objectives →
grounding links → background → guided tour → deep dive → design decisions →
review questions → exercises → verify → watch & listen → glossary.

**Commits are referenced relatively, never by hash.** Header **Diff:** lines
give a branch range (`learn/a-skeleton...learn/b-read-a-repo`); a lesson
covering several commits labels them `~N`, meaning `<that branch>~N`. Hashes do
not survive a rebase of the stack; relative refs do. To see the commits behind
any lesson with their current hashes:

```bash
git log --oneline learn/<previous>..learn/<this-one>
```
