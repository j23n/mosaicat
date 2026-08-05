/**
 * Copy a single file, with a fallback that Bun's `$bunfs` needs.
 *
 * `fs.cp` / `fs.promises.cp` call `lstat`, which fails on files embedded in a
 * Bun-compiled binary even though `readFile` / `stat` succeed. Template assets
 * (`atmo.css`, `decrypt.js`, `reactions.js`) are read from that virtual FS when
 * atmo is shipped as a single binary — see ADR 004.
 *
 * Real disk paths (blob cache, project overrides, local preview images) keep
 * using `cp` on the happy path; the fallback is only for the bunfs gap.
 */

import { cp, readFile, writeFile } from "node:fs/promises";

/** Copy `src` to `dest`, falling back to read+write when `cp` cannot lstat. */
export async function copyFile(src: string, dest: string): Promise<void> {
  try {
    await cp(src, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EINVAL") throw err;
    await writeFile(dest, await readFile(src));
  }
}
