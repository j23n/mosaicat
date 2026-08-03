/**
 * The publishable file format: markdown with a TOML frontmatter block.
 *
 * This is *operator* input — the person running `atmo publish` typed it — so
 * it gets the config posture, not the record posture: strict zod validation,
 * unknown keys rejected, readable per-field errors, and a hard failure rather
 * than a silent skip. Compare `src/document.ts`, where the same lexicon read
 * back off the network is treated as hostile and never throws.
 *
 * The writeback helpers are deliberately textual: they insert or remove one
 * line inside the existing `+++` block and leave every other byte of the file
 * alone. Reserializing the TOML would clobber the author's comments, ordering
 * and spacing to save us a regex.
 */

import { parse as parseToml } from "smol-toml";
import { z } from "zod";

export class FrontmatterError extends Error {}

const FrontmatterSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    slug: z.string().optional(),
    /** TOML datetime or string; normalized to a Date either way. */
    published: z
      .union([z.date(), z.string()])
      .optional()
      .transform((value, ctx) => {
        if (value === undefined) return undefined;
        const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
        if (Number.isNaN(date.getTime())) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "not a parseable date" });
          return z.NEVER;
        }
        return date;
      }),
    cover: z.string().optional(),
    /** Pin to one configured source; publishing to any other refuses. */
    source: z.string().optional(),
    /** Written back by `atmo publish`; its presence means "already published". */
    rkey: z.string().optional(),
  })
  .strict();

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export interface FrontmatterFile {
  frontmatter: Frontmatter;
  /** The markdown after the closing fence, one leading blank line stripped. */
  body: string;
}

/** Split into lines that keep their own newline, so joins are byte-exact. */
function splitKeepingNewlines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

/** Index of the closing `+++` line, after verifying the opening one. */
function fenceBounds(filePath: string, lines: string[]): number {
  if ((lines[0] ?? "").trim() !== "+++") {
    throw new FrontmatterError(
      `${filePath}: no +++ frontmatter fence — every publishable file needs one (with a title)`,
    );
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "+++") return i;
  }
  throw new FrontmatterError(`${filePath}: frontmatter fence is never closed`);
}

/** Parse one publishable file. Throws `FrontmatterError`, prefixed with the path. */
export function parseFrontmatter(filePath: string, text: string): FrontmatterFile {
  const lines = splitKeepingNewlines(text);
  const close = fenceBounds(filePath, lines);

  let raw: unknown;
  try {
    raw = parseToml(lines.slice(1, close).join(""));
  } catch (e) {
    throw new FrontmatterError(`${filePath}: could not parse frontmatter: ${(e as Error).message}`);
  }

  const result = FrontmatterSchema.safeParse(raw);
  if (!result.success) {
    const report = result.error.issues.map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `  ${path}: ${i.message}`;
    });
    throw new FrontmatterError(`${filePath}: invalid frontmatter:\n${report.join("\n")}`);
  }

  const body = lines
    .slice(close + 1)
    .join("")
    .replace(/^\r?\n/, "");
  return { frontmatter: result.data, body };
}

const keyLine = (key: string) => new RegExp(`^\\s*${key}\\s*=`);

/**
 * Insert `key = tomlValue` into the frontmatter block, or replace the line if
 * the key is already there. `tomlValue` is TOML source text, already quoted if
 * it needs to be. Everything outside that one line is preserved byte-for-byte.
 */
export function setFrontmatterValue(text: string, key: string, tomlValue: string): string {
  const lines = splitKeepingNewlines(text);
  const close = fenceBounds("(writeback)", lines);
  const matcher = keyLine(key);

  for (let i = 1; i < close; i++) {
    if (matcher.test(lines[i]!)) {
      const newline = lines[i]!.endsWith("\n") ? "\n" : "";
      lines[i] = `${key} = ${tomlValue}${newline}`;
      return lines.join("");
    }
  }

  lines.splice(close, 0, `${key} = ${tomlValue}\n`);
  return lines.join("");
}

/** Delete the `key = …` line from the frontmatter block, if present. */
export function removeFrontmatterKey(text: string, key: string): string {
  const lines = splitKeepingNewlines(text);
  const close = fenceBounds("(writeback)", lines);
  const matcher = keyLine(key);

  for (let i = 1; i < close; i++) {
    if (matcher.test(lines[i]!)) {
      lines.splice(i, 1);
      return lines.join("");
    }
  }
  return text;
}
