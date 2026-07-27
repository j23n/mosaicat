# atmo

A static site generator **for an ATProto repo**.

Point it at a handle and it builds a website from the records in that account's
Personal Data Server — posts, and anything else the account's other apps have
written there. No database, no server, no CMS.

```bash
npm install -g atmo

atmo init you.example.com     # writes atmo.toml
atmo pull                     # fetch records + blobs into .atmo/cache
atmo build                    # render the cache into ./dist
```

## Why

Your writing already lives in your repo. `site.standard.document` is a shared
lexicon that [Leaflet](https://leaflet.pub), pckt, Offprint and others already
read and write — so your content is portable whether or not this tool exists.

That leaves rendering as the only part worth owning:

- **The repo is the only content store.** No local models, no sync, no drift.
- **Authoring is someone else's job.** Write in a browser or on your phone with
  any standard.site app, or publish markdown with
  [Sequoia](https://sequoia.pub/). `atmo` never writes to your repo, so it
  needs no credentials and no OAuth.
- **Nothing at request time.** Blobs are downloaded and served locally, so a
  slow or unreachable PDS can't affect a reader.
- **Reactions come from the browser.** Bluesky replies and cross-app backlinks
  are fetched client-side, so they stay live without touching the build.
- **Private posts are optional**, encrypted at build time with
  [age](https://age-encryption.org/) and served at unguessable derived paths.

## Rendering more than posts

Your repo holds records other apps wrote for you. Add the NSID and they get a
page:

```toml
[[source]]
name        = "books"
handle      = "you.example.com"
collections = ["buzz.bookhive.book"]
```

A lexicon `atmo` has never seen still renders, through a generic template. To
style one, add `templates/collections/<nsid>.eta` — the filename is the whole
registration mechanism.

## Customising

Templates resolve from your `templates/` directory first, then the built-in
defaults. Override one file and everything else keeps working:

```
templates/post.eta            one page type
templates/atmo.css            the stylesheet
templates/base.eta            the layout
templates/collections/…       per-lexicon renderers
```

## Commands

|                      |                                                                      |
| -------------------- | -------------------------------------------------------------------- |
| `atmo init <handle>` | write `atmo.toml`                                                    |
| `atmo pull`          | the only command that touches the network                            |
| `atmo build`         | the only command that writes output; refuses if the site looks wrong |
| `atmo doctor`        | config, cache and model health                                       |

Exit codes: `2` bad config, `3` network, `4` build refused, `5` missing
passphrase.

## Docs

- [Deploying](docs/deploy.md) — CI, hosting, freshness, backups
- [The course](docs/learning/) — how this was built, one branch at a time

## License

BSD 3-Clause. See [LICENSE](LICENSE).
