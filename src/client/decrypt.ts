/**
 * The browser half of branch `i`. Bundled to `dist/assets/decrypt.js`.
 *
 * It uses the *same* `age-encryption` library the build used, so there is no
 * ciphertext format defined anywhere in this project — the only thing both
 * sides had to agree on is "an age file", which age already specifies.
 *
 * Flow:
 *   1. read the passphrase-wrapped identity embedded in this page
 *   2. unwrap it  (one scrypt — the only slow step)
 *   3. derive the manifest path from the identity, fetch and decrypt it
 *   4. render the list; each entry links to its own derived path
 *
 * No plaintext index exists anywhere. The page you are reading is public and
 * archivable, and contains no post URLs.
 */

import { Decrypter } from "age-encryption";

const PATH_LENGTH = 16;
const RFC4648_LOWER = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
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

async function derivePath(identity: string, label: string): Promise<string> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const key = await crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label));
  return base32(new Uint8Array(mac)).slice(0, PATH_LENGTH);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Remember the identity for this tab only. Never localStorage. */
const SESSION_KEY = "atmo:identity";

interface ManifestEntry {
  rkey: string;
  title: string;
  publishedAt: string;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // decrypted text is still text
  return node;
}

async function unwrap(wrapped: Uint8Array, passphrase: string): Promise<string | null> {
  try {
    const decrypter = new Decrypter();
    decrypter.addPassphrase(passphrase);
    return new TextDecoder().decode(await decrypter.decrypt(wrapped));
  } catch {
    return null;
  }
}

async function fetchAndDecrypt(identity: string, path: string): Promise<string | null> {
  try {
    const response = await fetch(`/p/${path}/payload.age`, { credentials: "omit" });
    if (!response.ok) return null;
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return new TextDecoder().decode(await decrypter.decrypt(bytes));
  } catch {
    return null;
  }
}

function boot(): void {
  const root = document.querySelector<HTMLElement>("[data-atmo-private]");
  if (!root) return;

  const mode = root.getAttribute("data-mode") ?? "index";
  const status = el("p", "private-status");
  const output = el("div", "private-output");

  const form = document.createElement("form");
  form.className = "private-form";
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "current-password";
  input.placeholder = "passphrase";
  input.required = true;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Unlock";
  form.append(input, submit);

  root.append(form, status, output);

  const renderIndex = async (identity: string) => {
    const path = await derivePath(identity, "index");
    const json = await fetchAndDecrypt(identity, path);
    if (json === null) {
      status.textContent = "Could not load the index.";
      return;
    }
    const entries = JSON.parse(json) as ManifestEntry[];
    status.textContent = `${entries.length} private post(s).`;
    const list = el("ul", "private-list");
    for (const entry of entries) {
      const item = el("li");
      const link = document.createElement("a");
      link.textContent = entry.title || entry.rkey;
      link.rel = "noreferrer";
      link.href = `/p/${await derivePath(identity, `path:${entry.rkey}`)}/`;
      item.append(link);
      list.append(item);
    }
    output.replaceChildren(list);
  };

  const renderPost = async (identity: string) => {
    const path = location.pathname.split("/").filter(Boolean)[1] ?? "";
    const html = await fetchAndDecrypt(identity, path);
    if (html === null) {
      status.textContent = "Could not decrypt this post.";
      return;
    }
    status.textContent = "";
    // The payload was rendered AND sanitized at build time, by the same
    // pipeline as every public page. It is trusted markup by then.
    output.innerHTML = html;
    form.hidden = true;
  };

  const show = async (identity: string) => {
    form.hidden = true;
    status.textContent = "Decrypting…";
    if (mode === "post") await renderPost(identity);
    else await renderIndex(identity);
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    status.textContent = "Unlocking… (this takes a moment by design)";
    submit.disabled = true;

    const wrappedB64 = root.getAttribute("data-wrapped") ?? "";
    void unwrap(fromBase64(wrappedB64), input.value).then(async (identity) => {
      submit.disabled = false;
      if (identity === null) {
        status.textContent = "Wrong passphrase.";
        return;
      }
      sessionStorage.setItem(SESSION_KEY, identity);
      await show(identity);
    });
  });

  const remembered = sessionStorage.getItem(SESSION_KEY);
  if (remembered) void show(remembered);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
