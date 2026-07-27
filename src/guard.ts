/**
 * Refusing to publish a bad build.
 *
 * A server that degrades badly self-heals: the next request tries again. A
 * static build does not. If a transient PDS error produces a site with no
 * posts and you deploy it, that empty site is what the world sees until someone
 * notices — and nothing will notice, because the build *succeeded*.
 *
 * So the failure mode has to move earlier. Branch `d` separated the site model
 * from emission precisely so there is a moment when the whole picture exists
 * and nothing has been written. These are the checks that run in that moment.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SiteModel } from "./site.js";

/** What the last successful build produced, for comparison. */
export interface BuildManifest {
  builtAt: string;
  pages: number;
  publicPages: number;
  collections: number;
}

/** Fraction of pages that may vanish between builds before we refuse. */
export const SHRINK_THRESHOLD = 0.5;

export type GuardSeverity = "error" | "warning";

export interface GuardFinding {
  severity: GuardSeverity;
  code: string;
  message: string;
}

export interface GuardOptions {
  /** Skip the shrink and empty checks — for a genuine deletion. */
  force?: boolean;
  previous?: BuildManifest | null;
}

function manifestPath(cacheDir: string): string {
  return join(cacheDir, "build-manifest.json");
}

export async function readManifest(cacheDir: string): Promise<BuildManifest | null> {
  try {
    return JSON.parse(await readFile(manifestPath(cacheDir), "utf8")) as BuildManifest;
  } catch {
    return null;
  }
}

export async function writeManifest(cacheDir: string, manifest: BuildManifest): Promise<void> {
  const path = manifestPath(cacheDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function manifestFor(site: SiteModel, now: Date): BuildManifest {
  return {
    builtAt: now.toISOString(),
    pages: site.pages.length,
    publicPages: site.publicPages.length,
    collections: site.collections.length,
  };
}

/**
 * Everything wrong with a build, worst first.
 *
 * Errors stop the build. Warnings are printed and ignored — the distinction is
 * whether a human could plausibly *want* this outcome.
 */
export function inspect(site: SiteModel, options: GuardOptions = {}): GuardFinding[] {
  const { force = false, previous = null } = options;
  const findings: GuardFinding[] = [];

  // A configured source with no cache means `pull` never ran or failed. The
  // site would come out missing a whole section, silently.
  for (const name of site.missingSources) {
    findings.push({
      severity: "error",
      code: "missing-source",
      message: `source "${name}" has no cache entry — run \`atmo pull\``,
    });
  }

  if (!force) {
    if (site.pages.length === 0 && site.collections.length === 0) {
      findings.push({
        severity: "error",
        code: "empty-site",
        message: "no pages and no collections — refusing to publish an empty site",
      });
    }

    if (previous !== null && previous.pages > 0) {
      const lost = previous.pages - site.pages.length;
      if (lost > 0 && lost / previous.pages >= SHRINK_THRESHOLD) {
        findings.push({
          severity: "error",
          code: "shrink",
          message:
            `page count fell from ${previous.pages} to ${site.pages.length} ` +
            `(${Math.round((lost / previous.pages) * 100)}% lost) — ` +
            "re-run `atmo pull`, or pass --force if this is intended",
        });
      }
    }
  }

  // The cost of branch `c`'s tolerance, made visible.
  if (site.skipped > 0) {
    findings.push({
      severity: "warning",
      code: "skipped-records",
      message:
        `${site.skipped} record(s) were skipped as unrenderable ` +
        "(usually a missing or unparseable publishedAt)",
    });
  }

  for (const page of site.publicPages) {
    if (page.doc.title.trim() === "") {
      findings.push({
        severity: "warning",
        code: "untitled",
        message: `document ${page.doc.rkey} has no title (renders as "Untitled")`,
      });
    }
  }

  const order = (f: GuardFinding) => (f.severity === "error" ? 0 : 1);
  return findings.sort((a, b) => order(a) - order(b));
}

export function hasErrors(findings: GuardFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

export class GuardError extends Error {
  constructor(readonly findings: GuardFinding[]) {
    super(
      findings.filter((f) => f.severity === "error").map((f) => f.message)[0] ?? "build refused",
    );
  }
}
