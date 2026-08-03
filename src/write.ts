/**
 * The authenticated XRPC client — the only place atmo writes to a PDS.
 *
 * Auth is an app password from the environment, exchanged for one session per
 * invocation; nothing is persisted. The secret rides in env, never config,
 * for the same reason as `ATMO_PASSPHRASE` in `src/private.ts`. Trust follows
 * provenance exactly as in `src/http.ts`: a session against a resolved
 * (handle) identity keeps the public-address check, a session against an
 * operator-configured `did` + `pds_url` may point somewhere private — and
 * records written there are plaintext, because privacy means an unreachable
 * PDS, not encrypted records (lesson i). Encryption stays a build concern.
 */

import type { Identity } from "./identity.js";
import { HttpError, postBytes, postJson, type Fetcher, type Lookup } from "./http.js";

/** Generic env var; `ATMO_APP_PASSWORD_<SOURCENAME>` takes precedence. */
export const APP_PASSWORD_ENV = "ATMO_APP_PASSWORD";

/** Missing or rejected credentials. The CLI maps this to exit code 6. */
export class AuthError extends Error {}

export interface WriteOptions {
  fetcher?: Fetcher;
  dnsLookup?: Lookup;
}

/** One signed-in PDS: the bearer token plus where and who it is valid for. */
export interface Session {
  accessJwt: string;
  did: string;
  pdsUrl: string;
  /** True when the endpoint was operator-configured; suppresses the SSRF check. */
  trusted: boolean;
}

/** A blob reference as `uploadBlob` returns it, embeddable in a record. */
export interface UploadedBlob {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
}

/**
 * App password for a source: `ATMO_APP_PASSWORD_<NAME>` (uppercased, dashes
 * to underscores) first, then the generic `ATMO_APP_PASSWORD`. Injected env,
 * like `passphraseFromEnv` in `src/private.ts`.
 */
export function appPasswordFromEnv(
  sourceName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const specific = env[`${APP_PASSWORD_ENV}_${sourceName.toUpperCase().replace(/-/g, "_")}`];
  if (specific !== undefined && specific.trim() !== "") return specific;
  const generic = env[APP_PASSWORD_ENV];
  return generic !== undefined && generic.trim() !== "" ? generic : null;
}

const shared = (options: WriteOptions) => ({
  ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
});

const bearer = (session: Session) => ({ authorization: `Bearer ${session.accessJwt}` });

/**
 * `com.atproto.server.createSession` — identifier is the handle when the
 * source has one, the DID otherwise. A 4xx is bad credentials (`AuthError`);
 * anything else stays an `HttpError` and exits as a network failure.
 */
export async function createSession(
  identity: Identity,
  password: string,
  options: WriteOptions = {},
): Promise<Session> {
  let body: { accessJwt?: unknown };
  try {
    body = await postJson(
      `${identity.pdsUrl}/xrpc/com.atproto.server.createSession`,
      { identifier: identity.handle ?? identity.did, password },
      { requirePublic: !identity.trusted, ...shared(options) },
    );
  } catch (e) {
    if (e instanceof HttpError && e.status !== undefined && e.status >= 400 && e.status < 500) {
      throw new AuthError(`could not sign in to ${identity.pdsUrl}: ${e.message}`);
    }
    throw e;
  }
  if (typeof body.accessJwt !== "string" || body.accessJwt === "") {
    throw new AuthError(`${identity.pdsUrl} returned a session without an accessJwt`);
  }
  return {
    accessJwt: body.accessJwt,
    did: identity.did,
    pdsUrl: identity.pdsUrl,
    trusted: identity.trusted,
  };
}

interface RecordResponse {
  uri?: unknown;
  cid?: unknown;
}

function asRecordResult(body: RecordResponse, host: string): { uri: string; cid: string } {
  if (typeof body.uri !== "string" || body.uri === "") {
    throw new HttpError(`${host} returned no record uri`);
  }
  return { uri: body.uri, cid: typeof body.cid === "string" ? body.cid : "" };
}

/** `com.atproto.repo.createRecord` — the PDS assigns the rkey. */
export async function createRecord(
  session: Session,
  collection: string,
  record: Record<string, unknown>,
  options: WriteOptions = {},
): Promise<{ uri: string; cid: string; rkey: string }> {
  const body = await postJson<RecordResponse>(
    `${session.pdsUrl}/xrpc/com.atproto.repo.createRecord`,
    { repo: session.did, collection, record },
    { requirePublic: !session.trusted, headers: bearer(session), ...shared(options) },
  );
  const result = asRecordResult(body, session.pdsUrl);
  return { ...result, rkey: result.uri.slice(result.uri.lastIndexOf("/") + 1) };
}

/** `com.atproto.repo.putRecord` — write at a known rkey (republish). */
export async function putRecord(
  session: Session,
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
  options: WriteOptions = {},
): Promise<{ uri: string; cid: string }> {
  const body = await postJson<RecordResponse>(
    `${session.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
    { repo: session.did, collection, rkey, record },
    { requirePublic: !session.trusted, headers: bearer(session), ...shared(options) },
  );
  return asRecordResult(body, session.pdsUrl);
}

/** `com.atproto.repo.deleteRecord`. Blobs are left to PDS garbage collection. */
export async function deleteRecord(
  session: Session,
  collection: string,
  rkey: string,
  options: WriteOptions = {},
): Promise<void> {
  await postJson(
    `${session.pdsUrl}/xrpc/com.atproto.repo.deleteRecord`,
    { repo: session.did, collection, rkey },
    { requirePublic: !session.trusted, headers: bearer(session), ...shared(options) },
  );
}

/** `com.atproto.repo.uploadBlob` — raw bytes in, an embeddable blob ref out. */
export async function uploadBlob(
  session: Session,
  bytes: Uint8Array,
  mimeType: string,
  options: WriteOptions = {},
): Promise<UploadedBlob> {
  const body = await postBytes<{ blob?: unknown }>(
    `${session.pdsUrl}/xrpc/com.atproto.repo.uploadBlob`,
    bytes,
    mimeType,
    { requirePublic: !session.trusted, headers: bearer(session), ...shared(options) },
  );
  const blob = body.blob as UploadedBlob | undefined;
  if (blob === undefined || typeof blob.ref?.$link !== "string" || blob.ref.$link === "") {
    throw new HttpError(`${session.pdsUrl} returned no blob ref from uploadBlob`);
  }
  return blob;
}
