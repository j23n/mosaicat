/**
 * Private posts: encrypted at build, decrypted in the browser.
 *
 * **No cryptography is implemented here.** Content encryption is the
 * [age](https://age-encryption.org/) format via `age-encryption` — a
 * TypeScript implementation by age's own author that runs in Node *and* in
 * browsers. Using one library on both sides means there is no wire format to
 * specify and no interop seam to get wrong, which is the single most common
 * way hand-rolled schemes fail.
 *
 * What *is* implemented here is path derivation, which is not encryption: an
 * HMAC over a label, used to decide where a file is written. Standard
 * primitive, used as intended.
 *
 * ## The shape
 *
 *   site identity   a random age X25519 identity, generated per build
 *   every payload   encrypted TO that identity   (fast, no KDF)
 *   the identity    wrapped under the passphrase (one scrypt, once)
 *
 * The alternative — passphrase-encrypting each post — runs scrypt per file, so
 * a reader would wait seconds *per page*. Wrapping the identity once means the
 * expensive step happens on unlock and every subsequent page is milliseconds.
 *
 * ## What this protects, and what it does not
 *
 * The ciphertext is public and permanent. Anyone who finds a file can attack it
 * offline, forever, with no rate limiting. Security is therefore exactly:
 * passphrase entropy × scrypt work factor. **Use a passphrase, not a password.**
 *
 * Derived paths are a second, independent layer: a file nobody can locate is
 * not attacked at all. Neither layer subsumes the other — a leaked URL still
 * needs the passphrase, and a guessed passphrase still needs the URLs.
 */

import { webcrypto } from "node:crypto";
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";

/**
 * scrypt work factor (log2 N) for the passphrase that wraps the identity.
 *
 * Deliberately above age's default: this ciphertext is published, so an
 * attacker gets unlimited offline attempts. ~1s on unlock, once per session.
 */
export const SCRYPT_WORK_FACTOR = 17;

/** Characters of a derived path. 16 base32 chars ≈ 80 bits. */
export const PATH_LENGTH = 16;

const RFC4648_LOWER = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, unpadded. An encoding, not a cipher. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += RFC4648_LOWER[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += RFC4648_LOWER[(value << (5 - bits)) & 31];
  return out;
}

/** The site key material for one build. */
export interface SiteKeys {
  /** age identity (secret). Never written to the output directory. */
  identity: string;
  /** age recipient (public half). */
  recipient: string;
  /** Passphrase-wrapped identity, safe to publish. */
  wrapped: Uint8Array;
}

/**
 * Derive the HMAC key that decides paths.
 *
 * Keyed on the *identity*, not the passphrase, so the browser can compute
 * paths only after a successful unwrap — and so no second KDF is needed.
 */
async function pathKey(
  identity: string,
): Promise<Awaited<ReturnType<typeof webcrypto.subtle.importKey>>> {
  const material = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return webcrypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

/** The unguessable path segment for a label, e.g. `path:<rkey>` or `index`. */
export async function derivePath(identity: string, label: string): Promise<string> {
  const key = await pathKey(identity);
  const mac = await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(label));
  return base32(new Uint8Array(mac)).slice(0, PATH_LENGTH);
}

export const postLabel = (rkey: string): string => `path:${rkey}`;
export const MANIFEST_LABEL = "index";

/**
 * Generate a fresh identity and wrap it under the passphrase.
 *
 * A new identity per build means every path changes on every build, so the
 * caller must reuse one across builds — see `siteKeysFrom`.
 */
export async function createSiteKeys(passphrase: string): Promise<SiteKeys> {
  const identity = await generateIdentity();
  return siteKeysFrom(identity, passphrase);
}

/** Wrap an existing identity, so paths stay stable between builds. */
export async function siteKeysFrom(identity: string, passphrase: string): Promise<SiteKeys> {
  const recipient = await identityToRecipient(identity);
  const wrapper = new Encrypter();
  wrapper.setPassphrase(passphrase);
  wrapper.setScryptWorkFactor(SCRYPT_WORK_FACTOR);
  return { identity, recipient, wrapped: await wrapper.encrypt(identity) };
}

/** Recover an identity from its published wrapper. Used by tests and `doctor`. */
export async function unwrapIdentity(
  wrapped: Uint8Array,
  passphrase: string,
): Promise<string | null> {
  try {
    const decrypter = new Decrypter();
    decrypter.addPassphrase(passphrase);
    return new TextDecoder().decode(await decrypter.decrypt(wrapped));
  } catch {
    return null; // wrong passphrase, or not an age file
  }
}

/** Encrypt a payload to the site recipient. No KDF; fast enough per post. */
export async function encryptTo(recipient: string, plaintext: string): Promise<Uint8Array> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return encrypter.encrypt(plaintext);
}

/** Decrypt a payload with the site identity. Used by tests. */
export async function decryptWith(identity: string, ciphertext: Uint8Array): Promise<string> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  return new TextDecoder().decode(await decrypter.decrypt(ciphertext));
}

/** Base64 for embedding ciphertext in a page. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
