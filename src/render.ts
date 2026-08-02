/**
 * Templates.
 *
 * Two directories are searched: the project's `templates/`, then the bundled
 * defaults. A user overrides one file by creating a file of the same name and
 * nothing else changes — the same trick Django's template loaders use, and the
 * reason the default theme can stay this small.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Eta } from "eta";

/** Templates shipped with the package. */
export const BUILTIN_TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "templates");

/** Where a project may override them. */
export const PROJECT_TEMPLATES = "templates";

export interface Renderer {
  /** Render a named template with a context. */
  render(template: string, context: Record<string, unknown>): string;
  /** Wrap rendered body HTML in the base layout. */
  page(context: PageContext): string;
  /** Absolute path of a template file, honouring overrides. */
  resolveTemplate(name: string): string;
  /** First of `names` that exists, or null. Drives the NSID registry. */
  findTemplate(names: string[]): string | null;
}

export interface PageContext {
  title: string;
  description?: string;
  canonical?: string;
  noindex?: boolean;
  /** Absolute URL of a preview image, for og:image. */
  image?: string;
  /** Site navigation links. Absent when the site has nothing beyond posts. */
  nav?: { label: string; url: string }[];
  site: { title: string; description: string };
  body: string;
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function createRenderer(projectRoot = "."): Renderer {
  const overrides = resolve(projectRoot, PROJECT_TEMPLATES);
  const roots = existsSync(overrides) ? [overrides, BUILTIN_TEMPLATES] : [BUILTIN_TEMPLATES];

  const eta = new Eta({ views: roots[0]!, autoEscape: true, autoTrim: false });

  const resolveTemplate = (name: string): string => {
    for (const root of roots) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`no template named ${name} in ${roots.join(", ")}`);
  };

  const render = (template: string, context: Record<string, unknown>): string => {
    const path = resolveTemplate(template);
    // `formatDate` is injected rather than imported by templates, so an
    // override cannot reach into the module graph.
    return eta.renderString(readTemplate(path), { ...context, formatDate });
  };

  const findTemplate = (names: string[]): string | null => {
    for (const name of names) {
      for (const root of roots) {
        if (existsSync(join(root, name))) return name;
      }
    }
    return null;
  };

  const page = (context: PageContext): string => render("base.eta", { ...context });

  return { render, page, resolveTemplate, findTemplate };
}

const cache = new Map<string, string>();

function readTemplate(path: string): string {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  // Sync on purpose: templates are small, read once, and this keeps the
  // rendering functions synchronous and trivially testable.
  const text = readFileSync(path, "utf8");
  cache.set(path, text);
  return text;
}
