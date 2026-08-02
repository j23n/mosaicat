# Deploying

`atmo` produces a directory. Any static host serves it. The only decisions are
_where the build runs_ and _what triggers it_.

## The two topologies

**Public only — build in CI.** Nothing your build needs is private, so a
scheduled or webhook-triggered job can pull and build. See the workflow below.

**With private posts — build locally.** A private PDS on an internal network
has no route from a CI runner, and `$ATMO_PASSPHRASE` is a secret you probably
don't want in a hosted job anyway. Build on a machine that can reach the PDS
and deploy `dist/` from there.

You can also split: CI publishes the public site, and a local
`atmo build` produces the `/p/` tree as an overlay you upload separately.

## GitHub Actions

```yaml
name: Publish

on:
  schedule:
    - cron: "0 * * * *" # hourly; content written elsewhere shows up within the hour
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      - run: npm install -g atmo

      # Blobs are content-addressed, so a warm cache means near-zero downloads.
      - uses: actions/cache@v4
        with:
          path: .atmo
          key: atmo-cache-${{ github.run_id }}
          restore-keys: atmo-cache-

      - run: atmo pull
      - run: atmo build # exits non-zero if a guard refuses

      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
```

**The important line is `atmo build`.** It exits non-zero when the site looks
wrong (branch `h`), and because the deploy step comes after it, a refused build
never publishes. If your pipeline uploads `dist/` unconditionally — say, in a
separate job without `needs:` — you have disabled the guards. Check that.

Caching `.atmo` is worth it: records re-download but blobs don't, since a CID's
bytes can never change.

## Freshness

A static site is as fresh as its last build. Content written from another app
(Leaflet, pckt, Sequoia) appears on the next run.

- **Scheduled** — hourly is usually plenty for a personal site.
- **On demand** — `workflow_dispatch`, or a webhook you fire after publishing.
- **Firehose-triggered** — subscribe to Jetstream, filter for your DID, and
  trigger a rebuild on a commit. Seconds instead of an hour, at the cost of
  running a small always-on service. Rarely worth it for a blog.

## Hosts

Nothing here is host-specific; `dist/` is plain files.

- **GitHub Pages / Cloudflare Pages / Netlify** — point them at `dist/`.
- **Your own server** — `rsync -a --delete dist/ host:/var/www/site/`. The
  `--delete` matters for the same reason `build` clears `dist/`: a removed post
  should stop being served.

Two headers are worth setting if your host allows it:

```
/p/*   X-Robots-Tag: noindex
/p/*   Referrer-Policy: no-referrer
```

Both are already in the HTML for private pages; these are belt and braces.

## Backups

The public repo is replicated by every relay that crawls it, and exportable by
anyone:

```bash
curl "https://<pds>/xrpc/com.atproto.sync.getRepo?did=<did>" -o site.car
```

That CAR file is a signed, complete, app-neutral copy of your writing, obtained
with no cooperation from `atmo` — which is the property that makes this tool
replaceable.

**Two things are not covered by that**, and both are yours alone:

- **A private PDS's volume.** Unreachable means unreplicated. Back it up.
- **`.atmo/identity`.** Lose it and every derived path changes, breaking every
  private link you have shared. Keep it wherever you keep your passphrase.
