# b — Read a repo

> **Stack:** b/j · **base:** `learn/a-skeleton`
> **Diff:** `learn/a-skeleton...learn/b-read-a-repo` · **What it adds:**
> `atmo pull` — identity resolution, a bounded `listRecords` cursor walk, an
> SSRF-guarded HTTP layer, and a cache on disk. The first command that talks to
> the ATmosphere.

## The one-sentence version

Turn a handle into `(DID, PDS URL)`, walk every record out of the named
collections one page at a time, and write the raw JSON to
`.atmo/cache/<source>.json` — treating the PDS endpoint as **an address an
untrusted document told you to fetch**, because that is exactly what it is.

## Learning objectives

**ATProto**

- The resolution chain end to end: **handle → DID → DID document → PDS**, and
  which link is stable and which is reassignable.
- `did:plc` (resolved through a directory) vs `did:web` (the domain _is_ the
  identifier, no directory in the loop).
- Reading a DID document and finding the `AtprotoPersonalDataServer` service.
- `com.atproto.repo.listRecords`: `limit`, `cursor`, `reverse`, and why "all
  the records" is a **walk**, not a request.
- The shape of a record on the wire — `uri`, `cid`, `value` — and where the
  **rkey** actually comes from.
- Why reads need no credentials at all, which is the entire reason `atmo` has
  no auth code.

**Craft**

- **SSRF, and trust by provenance**: an endpoint you resolved is untrusted; one
  the operator typed is not. The same URL can be legitimate or an attack
  depending on where it came from.
- Why redirects must not be followed when the destination was validated.
- Dependency injection for `fetch` and DNS so the suite never opens a socket.
- Bounded loops over paginated APIs, and terminating on a page that advances
  nothing.
- A cache that stores **raw** data, versioned, so a code change can't make a
  stale entry silently wrong.

## Grounding: official docs

- Identity: DID — <https://atproto.com/specs/did> · handle —
  <https://atproto.com/specs/handle>
- `did:plc` method — <https://github.com/did-method-plc/did-method-plc>
- Repository, records, collections — <https://atproto.com/specs/repository>
- Record keys / TIDs — <https://atproto.com/specs/record-key>
- AT-URI — <https://atproto.com/specs/at-uri-scheme>
- XRPC — <https://atproto.com/specs/xrpc>
- `com.atproto.repo.listRecords` and friends —
  <https://docs.bsky.app/docs/category/http-reference>
- OWASP: Server-Side Request Forgery —
  <https://owasp.org/www-community/attacks/Server_Side_Request_Forgery>
- `AbortSignal.timeout` —
  <https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static>

## Background: where is the repo?

A source names an account. Before anything can be fetched, `atmo` has to answer
_where that account's data lives_, and the answer is a three-hop chain:

```
handle  --com.atproto.identity.resolveHandle-->  did:plc:ewvi7…
DID     --plc.directory  |  /.well-known/did.json-->  DID document
DID doc --service[type=AtprotoPersonalDataServer]-->  https://pds.example.com
```

Each hop is worth understanding:

**Handles are reassignable; DIDs are not.** `alice.bsky.social` is a pointer.
Alice can change it tomorrow, and someone else can take it. The DID never
changes. That is why the cache is keyed on the DID and why `Identity` carries
both — the handle is for display, the DID is for identity.

**`did:plc` needs a directory; `did:web` doesn't.** A `did:plc` is an opaque
identifier whose document lives in a verifiable log at `plc.directory`. A
`did:web:example.com` _is_ a domain — you fetch
`https://example.com/.well-known/did.json` and there is no third party in the
loop at all. Supporting both is ten lines and it's the difference between "a
protocol with a central registry" and "a protocol that permits one."

**The DID document names the PDS.** Somewhere in its `service` array is an
entry of type `AtprotoPersonalDataServer` whose `serviceEndpoint` is the origin
every subsequent call goes to.

Then the read itself. `listRecords` returns at most 100 records plus a
`cursor`; you pass the cursor back until it stops coming. Reads are
unauthenticated — no session, no app password, nothing. `atmo` renders sites
and never writes, so **this is all the protocol access the tool will ever
need.**

## Guided tour of the diff (read in this order)

1. **`src/http.ts`** — the outbound boundary, and the deep dive below. Read
   `isPrivateAddress` and its table of ranges, then `assertPublicUrl`, then
   `getJson`. Note `redirect: "manual"` and that a 3xx is an _error_.

2. **`src/identity.ts`** — `resolveSource` first, because it shows the two
   paths: a configured `did` + `pds_url` short-circuits everything, while a
   handle walks the chain and then has its result validated. Then
   `pdsFromDidDocument`, which accepts either the `type` or the `#atproto_pds`
   id fragment, because both appear in the wild.

3. **`src/repo.ts`** — `listRecords`. Look at the loop's two exit conditions
   and at how `rkey` is derived from the AT-URI rather than trusted from a
   field. Read the comment on `reverse=true`; it matters in branch `c`.

4. **`src/cache.ts`** — the wall between the two commands. Note `CACHE_VERSION`
   and that a version mismatch reads as _absent_ rather than as an error.

5. **`src/pull.ts`** — orchestration only. Note that one failing source aborts
   the whole pull.

6. **`tests/fake-pds.ts`** — an in-memory resolver, directory, and PDS,
   including real cursor pagination. Every test in the suite runs against this.

## Deep dive: the endpoint is attacker-controlled

Here is the sequence, stated plainly:

1. `atmo` resolves a handle it was configured with.
2. That returns a DID.
3. That DID's **document is served by whoever controls the DID**.
4. The document contains a URL.
5. `atmo` fetches that URL.

Step 5 is a request to an address chosen by someone else. If the document says
`http://169.254.169.254/latest/meta-data/`, a naive client will happily fetch
cloud credentials. That is **server-side request forgery**, and it arrives
through a completely ordinary-looking feature.

Three defences, and each closes a different hole:

**Validate the resolved address.** `assertPublicUrl` resolves the hostname and
refuses if _any_ answer is a loopback, private, link-local, CGNAT, or multicast
address. Note "any" — a host resolving to both a public and a private address
must be refused, or a single honest answer launders the attack. There is a test
for exactly that.

**Refuse redirects.** This is the subtle one. You validated
`https://evil.example` and it resolved publicly — fine. Then it replies `302
Location: http://169.254.169.254/`. If `fetch` follows redirects (its default),
the request you actually make is to an address that **was never checked**, and
your validation is decorative. So `redirect: "manual"`, and a 3xx is an error.

**Trust by provenance, not by address.** The naive fix is "reject all internal
addresses everywhere," and it would break branch `i`, where a private PDS on an
internal network is the entire point. So the rule is about _where the URL came
from_:

| Origin of the endpoint          | Trusted | Rationale                             |
| ------------------------------- | ------- | ------------------------------------- |
| `did` + `pds_url` in the config | yes     | The operator typed it                 |
| Resolved from a DID document    | **no**  | An account you don't control wrote it |

`Identity.trusted` carries that decision, and `listRecords` passes
`requirePublic: !identity.trusted`. One boolean, threaded from the place that
knows the provenance to the place that makes the request.

**What is still open**, and say it out loud rather than implying safety: DNS
can return a different answer between the check and the request — _DNS
rebinding_. Closing it properly needs an HTTP agent pinned to the address you
validated. This is a floor, not a ceiling.

## Deep dive: a walk that always terminates

```ts
while (records.length < maxRecords) {
  const body = await getJson(…, { cursor, limit: min(100, maxRecords - records.length) });
  …
  cursor = typeof body.cursor === "string" ? body.cursor : undefined;
  if (cursor === undefined || page.length === 0) break;
}
```

Three independent stopping conditions, and it takes all three:

- **The cap.** A repo with a million records must not turn one build into an
  unbounded crawl. `max_records` is per-source config.
- **No cursor.** The normal, well-behaved end.
- **An empty page _with_ a cursor.** This is the one people miss. A PDS that
  returns `{records: [], cursor: "same-as-before"}` — buggy or hostile — makes
  a loop guarded only by the cursor spin forever. Since the loop's other guard
  advances only when records arrive, a page that adds nothing must break out on
  its own.

Also note the `limit`: `min(100, remaining)`. Without it, a `max_records` of
120 fetches 100, then asks for another 100 and throws 80 away.

## Design decisions & "why not X"

- **Why hand-roll resolution instead of using `@atproto/api`?** The SDK is
  excellent and for an app you should use it. Here, the resolution chain _is_
  the lesson, and the SSRF boundary has to be somewhere you control. Fifty
  lines, no dependency, and every hop visible.
- **Why store raw records rather than parsed ones?** Raw JSON stays valid
  across code changes. A cached parse goes stale the moment a field is renamed,
  and nothing tells you — you just render yesterday's shape. Parsing is
  microseconds; the fetch is what's expensive, so cache the fetch.
- **Why does one failing source abort the whole pull?** Because the alternative
  writes a partial cache, and `build` cannot tell a partial cache from a
  complete one. The site would come out missing a section, silently, and
  publish successfully. Branch `h` builds on this: fail loudly at fetch time,
  never quietly at render time.
- **Why `reverse=true` if display order gets decided later anyway?** It decides
  _which_ records survive `max_records`. Newest-first at the wire level means
  an over-cap repo keeps its most recent thousand rather than its oldest.
- **Why inject `fetch` and DNS rather than mocking the module?** The injected
  version is typed, so a test can't drift from the real signature, and
  `tests/fake-pds.ts` ends up being a readable description of the protocol
  rather than a pile of stubs.

## Review questions

1. _`assertPublicUrl` passes, then the request is made. What can still go
   wrong?_ — DNS rebinding: the name can resolve differently for the actual
   request. Fixing it requires pinning the connection to the validated address.
   The code names this rather than pretending otherwise.
2. _Why is `rkey` derived from the AT-URI instead of read from a field?_ — The
   URI is constructed by the PDS and is the record's actual address. A field
   inside `value` is authored by whoever wrote the record and can say anything.
   Derive identity from the envelope, never from the payload.
3. _A source is configured with `did` + `pds_url` pointing at
   `http://10.0.0.5:3000`. Why is that allowed, when the same address from a
   DID document is refused?_ — Provenance. The operator typed one; an untrusted
   third party supplied the other. Branch `i` depends on the first case working.

## Exercises

1. **Watch the walk.** Set `max_records = 150` against a repo with more than
   that and count the requests in `net.calls`. Now set it to `50`. What `limit`
   does the first call use, and why does that matter?
2. **Break the guard.** Delete the `redirect: "manual"` option and write a test
   proving the SSRF check can be bypassed with a 302. Then put it back.
3. **Add `did:web`.** The code supports it; the fake network doesn't. Extend
   `tests/fake-pds.ts` to serve `/.well-known/did.json` and add a test that
   resolves a `did:web` source with no directory involved.
4. **A hostile PDS.** Make the fake return `{records: [], cursor: "stuck"}`
   forever. Confirm the walk terminates. Then remove the `page.length === 0`
   condition and confirm it doesn't.

## Verify it yourself

```bash
npm test                          # 48 tests, no sockets opened

cp atmo.example.toml atmo.toml    # set `handle` to a real account
npm run atmo -- pull
cat .atmo/cache/posts.json | head -40
```

Compare what you pulled with the same repo in [pdsls.dev](https://pdsls.dev) —
same records, same rkeys.

## Watch & listen

- [Introduction to AT Protocol](https://mackuba.eu/2025/08/20/introduction-to-atproto/)
  — mackuba. Read the identity and repo sections alongside `identity.ts`.
- [SE Radio 651: Paul Frazee on Bluesky and the AT Protocol](https://se-radio.net/2025/01/se-radio-651-paul-frazee-on-bluesky-and-the-at-protocol/)
  — why the protocol separates identity from hosting at all.
- Open [plc.directory/did:plc:ewvi7nxzyoun6zhxrhs64oiz](https://plc.directory/did:plc:ewvi7nxzyoun6zhxrhs64oiz)
  and find the service entry `pdsFromDidDocument` looks for. It's a real
  document, and it's short.

## Glossary

- **DID** — immutable account identifier (`did:plc:…`, `did:web:…`).
- **DID document** — JSON describing an account, including where its repo is.
- **PDS** — Personal Data Server; hosts repos.
- **Collection / NSID** — a typed set of records / its reverse-DNS name.
- **rkey** — record key; the last segment of the AT-URI.
- **Cursor walk** — repeated paged calls, each passing back the last cursor.
- **SSRF** — coercing a server into fetching an address of the attacker's
  choosing.
- **Provenance-based trust** — deciding whether an endpoint may be internal
  from _who supplied it_, not from the address itself.
