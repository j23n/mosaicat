# 002: The publish command — a write side for the pipeline

- **Status:** live
- **Date:** 2026-08-03
- **Supersedes:** —

## Context

atmo could read a repo but not write one: getting a post _into_ the PDS meant
using another app or raw XRPC. `atmo publish` adds the missing verb — local
markdown files become `site.standard.document` records, `atmo unpublish`
deletes them. That opened a cluster of decisions with real alternatives:
how to authenticate (OAuth flow, persisted tokens, or an env-var app
password), what the file format is (YAML vs TOML frontmatter), how a file
remembers its record (derived rkeys, querying the PDS, or writing the rkey
back into the file), what shape the record's body takes (a Leaflet block
document vs a plain markdown string), and whether publishing to the private
PDS should encrypt.

## Decision

Publish is a third network verb that never touches the cache or `dist/`.
Specifically:

- **App-password auth from the environment, not OAuth.** The password is
  read from `ATMO_APP_PASSWORD_<SOURCENAME>` (uppercased, dashes to
  underscores) first, then `ATMO_APP_PASSWORD` — same posture as
  `ATMO_PASSPHRASE`: secrets ride in env, never config. One
  `createSession` per invocation, nothing persisted. Missing or rejected
  credentials are `AuthError`, exit code **6**. Revisit if atmo ever runs
  hosted on someone else's machine, where handing over an app password is
  no longer acceptable.
- **TOML `+++` frontmatter, not YAML.** The config is already TOML and
  `smol-toml` is already a dependency; one syntax for operators, zero new
  dependencies.
- **Strict parsing for operator input.** Frontmatter gets the config
  posture (zod, `.strict()`, readable per-field failures, exit 2) — the
  deliberate opposite of the tolerant record parsing in `src/document.ts`.
  The person who typed the file is present and can fix it; a hard failure
  is a feature.
- **rkey writeback into the file, not a derived rkey or a PDS query.** On
  first publish the assigned rkey (and, when absent, `published`) is
  textually inserted into the frontmatter — never a reserialization, so the
  author's formatting survives. The file is the join between disk and repo;
  republishing is `putRecord` at that rkey.
- **Unpublish requires the written-back rkey and only calls
  `deleteRecord`.** You can only unpublish what this workflow published;
  blobs are left to PDS garbage collection.
- **`content` is a plain markdown string plus an always-written
  `textContent`.** A Leaflet-blocks writer is deliberately deferred: when
  Leaflet ships its planned markdown content block, we wrap the same string
  — no compiler. Relative image URLs are uploaded and rewritten to the
  `atproto://getBlob?cid=` form that pull/build already round-trip.
- **Publishing to a private source writes plaintext.** Encryption remains
  exclusively a build concern; the lesson-i threat model holds — privacy is
  an unreachable PDS, not encrypted records. The `did` + `pds_url` source
  form keeps its trusted, non-public endpoint, exactly as in pull.
- **`--source` is required whenever the config has more than one source** —
  no default, no guessing — and a file may pin `source = "name"` in its
  frontmatter, which refuses a publish to any other source.

## Consequences

Publishing needs no browser and works against a private PDS, at the price
that an app password sits in the operator's environment — acceptable for a
personal CLI, the stated trigger to revisit. The rkey lives only in the
file: lose the file (or its frontmatter) and atmo can no longer update or
delete that record without manual XRPC. Writeback means `publish` mutates
its input files, which surprises tooling that expects read-only builds; a
failure mid-batch leaves earlier files written back and correct, later ones
untouched. The plain-string `content` renders fine in atmo but is not a
Leaflet block document, so Leaflet-native readers fall back to
`textContent` until the deferred writer lands. Exit code 6 is now claimed;
the next failure mode takes 7.
