import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyFile } from "../src/copy-file.js";

describe("copyFile", () => {
  it("copies bytes on a normal filesystem path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atmo-copy-"));
    const src = join(dir, "in.txt");
    const dest = join(dir, "out.txt");
    await writeFile(src, "hello-copy\n", "utf8");
    await copyFile(src, dest);
    expect(await readFile(dest, "utf8")).toBe("hello-copy\n");
  });
});
