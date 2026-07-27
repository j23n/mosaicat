/**
 * Turning a configured source into an address you can fetch from.
 *
 *   handle  --com.atproto.identity.resolveHandle-->  DID
 *   DID     --plc.directory | did:web well-known-->  DID document
 *   DID doc --service[AtprotoPersonalDataServer]-->  PDS URL
 *
 * A source that supplies `did` + `pds_url` skips all of it. That path is what
 * makes an unreachable PDS usable, and it is also the only path that is
 * allowed to point somewhere non-public.
 */

import type { Source } from "./config.js";
import { assertPublicUrl, getJson, HttpError, type Fetcher, type Lookup } from "./http.js";

/** Public instance used only to turn a handle into a DID. */
export const DEFAULT_RESOLVER = "https://public.api.bsky.app";

export const PLC_DIRECTORY = "https://plc.directory";

const PDS_SERVICE_TYPE = "AtprotoPersonalDataServer";

export interface Identity {
  /** Immutable account id. Cache keys use this, never the handle. */
  did: string;
  /** Where this repo is served from. */
  pdsUrl: string;
  /** Present only when the identity came from a handle. */
  handle?: string;
  /** True when the operator configured the endpoint directly. */
  trusted: boolean;
}

export class IdentityError extends Error {}

interface DidDocument {
  service?: { id?: string; type?: string; serviceEndpoint?: unknown }[];
}

export interface ResolveOptions {
  resolverUrl?: string;
  plcUrl?: string;
  fetcher?: Fetcher;
  dnsLookup?: Lookup;
}

/** handle -> DID via the public resolver. */
export async function resolveHandle(handle: string, options: ResolveOptions = {}): Promise<string> {
  const { resolverUrl = DEFAULT_RESOLVER } = options;
  let body: { did?: unknown };
  try {
    body = await getJson(`${resolverUrl}/xrpc/com.atproto.identity.resolveHandle`, {
      params: { handle },
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
    });
  } catch (e) {
    throw new IdentityError(`could not resolve handle ${handle}: ${(e as Error).message}`);
  }
  if (typeof body.did !== "string" || !body.did.startsWith("did:")) {
    throw new IdentityError(`resolver returned no DID for ${handle}`);
  }
  return body.did;
}

/** DID -> DID document. `did:plc` via the directory, `did:web` via well-known. */
export async function fetchDidDocument(
  did: string,
  options: ResolveOptions = {},
): Promise<DidDocument> {
  const { plcUrl = PLC_DIRECTORY } = options;
  const shared = {
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
  };

  if (did.startsWith("did:plc:")) {
    return getJson<DidDocument>(`${plcUrl}/${encodeURIComponent(did)}`, shared);
  }

  if (did.startsWith("did:web:")) {
    // The domain *is* the identifier — no directory in the loop.
    const rest = did.slice("did:web:".length);
    const [domain, ...path] = rest.split(":");
    if (domain === undefined || domain === "") {
      throw new IdentityError(`malformed did:web: ${did}`);
    }
    const suffix = path.length > 0 ? `/${path.join("/")}` : "/.well-known";
    return getJson<DidDocument>(`https://${decodeURIComponent(domain)}${suffix}/did.json`, shared);
  }

  throw new IdentityError(`unsupported DID method: ${did}`);
}

/** Pull the PDS service endpoint out of a DID document. */
export function pdsFromDidDocument(doc: DidDocument, did: string): string {
  for (const service of doc.service ?? []) {
    const matchesType = service?.type === PDS_SERVICE_TYPE;
    const matchesId = typeof service?.id === "string" && service.id.endsWith("#atproto_pds");
    if ((matchesType || matchesId) && typeof service?.serviceEndpoint === "string") {
      return service.serviceEndpoint.replace(/\/+$/, "");
    }
  }
  throw new IdentityError(`DID document for ${did} names no PDS`);
}

/** Resolve a configured source to something fetchable. */
export async function resolveSource(
  source: Source,
  options: ResolveOptions = {},
): Promise<Identity> {
  // Configured verbatim: no network, and the endpoint may be non-public.
  if (source.did !== undefined && source.pds_url !== undefined) {
    return {
      did: source.did,
      pdsUrl: source.pds_url.replace(/\/+$/, ""),
      trusted: true,
      ...(source.handle !== undefined ? { handle: source.handle } : {}),
    };
  }

  if (source.handle === undefined) {
    throw new IdentityError(`source "${source.name}" has no identity`);
  }

  const did = await resolveHandle(source.handle, options);
  const doc = await fetchDidDocument(did, options);
  const pdsUrl = pdsFromDidDocument(doc, did);

  // Derived from an untrusted document, so it must be publicly routable.
  try {
    await assertPublicUrl(pdsUrl, options.dnsLookup);
  } catch (e) {
    if (e instanceof HttpError) throw new IdentityError(e.message);
    throw e;
  }

  return { did, pdsUrl, handle: source.handle, trusted: false };
}
