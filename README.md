# atmo

A static site generator **for an ATProto repo**.

Point it at a handle and it builds a website from the records in that account's
Personal Data Server — posts, and anything else the account's other apps have
written there. No database, no server, no CMS.

```bash
atmo pull      # fetch records + blobs from the PDS into a local cache
atmo build     # render the cache into ./dist
```

## Why

Your writing already lives in your repo. `site.standard.document` is a shared
lexicon that Leaflet, pckt, Offprint, and others already read and write — so the
content is portable whether or not this tool exists.

That leaves rendering as the only thing worth owning. `atmo` is the renderer:

- **The repo is the only content store.** No local models, no sync, no drift.
- **Authoring is someone else's job.** Write in Leaflet or pckt from a browser
  or phone, or publish markdown with a CLI. `atmo` never writes to your repo.
- **Nothing at request time.** Blobs become local assets, so a slow or
  unreachable PDS can't affect a reader.
- **Reactions come from the browser.** Replies and likes are fetched
  client-side, so they stay live without touching the build.
- **Private posts are optional**, encrypted at build time with a vetted
  implementation and served at unguessable paths.

## Status

Early. Being built in the open as a stacked series of reviewable branches —
see [`docs/learning/`](docs/learning/) once the first lands.

## License

BSD 3-Clause. See [LICENSE](LICENSE).
