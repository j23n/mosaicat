import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { configFor, init, InitError } from "../src/init.js";

const temp = () => mkdtemp(join(tmpdir(), "atmo-init-"));

describe("configFor", () => {
  // The scaffold's whole job: produce something that actually loads.
  it("emits a config the real parser accepts", () => {
    const config = parseConfig(configFor({ handle: "you.example.com" }));
    expect(config.source[0]).toMatchObject({ name: "posts", handle: "you.example.com" });
  });

  it("uses the handle as the title when none is given", () => {
    expect(parseConfig(configFor({ handle: "you.example.com" })).site.title).toBe(
      "you.example.com",
    );
  });

  it("honours title and base_url", () => {
    const config = parseConfig(
      configFor({ handle: "h", title: "My Site", baseUrl: "https://mine.test" }),
    );
    expect(config.site.title).toBe("My Site");
    expect(config.site.base_url).toBe("https://mine.test");
  });

  it("keeps the optional sources commented out", () => {
    const config = parseConfig(configFor({ handle: "h" }));
    expect(config.source).toHaveLength(1);
    expect(configFor({ handle: "h" })).toContain('# name        = "private"');
  });
});

describe("init", () => {
  it("writes a config, a templates directory and gitignore entries", async () => {
    const root = await temp();
    const written = await init(root, { handle: "you.example.com" });

    expect(written).toContain("atmo.toml");
    expect(written).toContain("templates/.gitkeep");
    expect(written).toContain(".gitignore");

    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignore).toContain("dist/");
    expect(ignore).toContain(".atmo/identity");
  });

  it("refuses to clobber an existing config", async () => {
    const root = await temp();
    await init(root, { handle: "a" });
    await expect(init(root, { handle: "b" })).rejects.toThrow(InitError);
  });

  it("overwrites under force", async () => {
    const root = await temp();
    await init(root, { handle: "a.example.com" });
    await init(root, { handle: "b.example.com", force: true });
    expect(await readFile(join(root, "atmo.toml"), "utf8")).toContain("b.example.com");
  });

  it("requires a handle", async () => {
    await expect(init(await temp(), { handle: "  " })).rejects.toThrow(/handle is required/);
  });

  it("appends to an existing gitignore without destroying it", async () => {
    const root = await temp();
    await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");
    await init(root, { handle: "h" });

    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignore).toContain("node_modules/");
    expect(ignore).toContain(".atmo/");
  });

  it("does not duplicate gitignore entries on a second run", async () => {
    const root = await temp();
    await init(root, { handle: "h" });
    const first = await readFile(join(root, ".gitignore"), "utf8");
    await init(root, { handle: "h", force: true });
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(first);
  });

  // Branch `d`'s search path means an empty directory inherits every default.
  it("copies no templates", async () => {
    const root = await temp();
    const written = await init(root, { handle: "h" });
    expect(written.filter((f) => f.endsWith(".eta"))).toHaveLength(0);
  });
});
