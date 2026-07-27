/**
 * Every outbound request goes through here.
 *
 * atmo fetches URLs it did not choose: a handle resolves to a DID document,
 * and that document names a PDS endpoint. An account you don't control decides
 * that string. Treating it as trusted is a server-side request forgery hole,
 * so resolved endpoints are validated before they are used.
 *
 * Endpoints written in the config are a different case — the operator typed
 * them, and a private PDS on an internal network is a legitimate target. Trust
 * therefore follows *provenance*, not the address.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Injected so tests never touch the network. */
export type Fetcher = typeof globalThis.fetch;

/** Injected so tests never touch DNS. */
export type Lookup = (hostname: string) => Promise<string[]>;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const [a, b] = parts as [number, number];
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local: cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]!;
  if (addr === "::" || addr === "::1") return true;
  if (addr.startsWith("fe80") || addr.startsWith("fc") || addr.startsWith("fd")) return true;
  if (addr.startsWith("::ffff:")) return isPrivateV4(addr.slice(7));
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true; // unparseable: refuse
}

/**
 * Throw unless every address `url`'s host resolves to is publicly routable.
 *
 * Note the residual race: DNS can return a different answer between this check
 * and the request (DNS rebinding). Closing that needs a pinned-IP agent; this
 * blocks the easy attacks and names the boundary.
 */
export async function assertPublicUrl(url: string, dnsLookup: Lookup = defaultLookup) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(`not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(`refusing non-HTTP scheme: ${parsed.protocol}`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) !== 0 ? [host] : await dnsLookup(host).catch(() => []);

  if (addresses.length === 0) throw new HttpError(`could not resolve ${host}`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new HttpError(`refusing to fetch ${host}: resolves to non-public ${address}`);
    }
  }
}

export interface GetJsonOptions {
  /** Query parameters; undefined values are dropped. */
  params?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  /** False for operator-configured endpoints (a private PDS is legitimate). */
  requirePublic?: boolean;
  fetcher?: Fetcher;
  dnsLookup?: Lookup;
}

/**
 * GET a URL and parse JSON.
 *
 * Redirects are NOT followed. A PDS that 3xx-redirects is either broken or
 * hostile, and following it would defeat the check above by moving the real
 * destination somewhere that was never validated.
 */
export async function getJson<T = unknown>(url: string, options: GetJsonOptions = {}): Promise<T> {
  const {
    params,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    requirePublic = true,
    fetcher = globalThis.fetch,
    dnsLookup,
  } = options;

  const target = new URL(url);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) target.searchParams.set(key, String(value));
  }

  if (requirePublic) await assertPublicUrl(target.toString(), dnsLookup);

  let response: Response;
  try {
    response = await fetcher(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
  } catch (e) {
    throw new HttpError(`request to ${target.host} failed: ${(e as Error).message}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new HttpError(`refusing redirect from ${target.host}`, response.status);
  }
  if (!response.ok) {
    throw new HttpError(`${target.host} returned ${response.status}`, response.status);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new HttpError(`${target.host} returned invalid JSON`);
  }
}
