/**
 * Identity derivation for generated plugins.
 *
 * `cognia plugin import` never generates a signing key and never writes
 * `author.publicKey`: signing is a distribution concern, and an author who
 * wants it runs `cognia plugin keygen` deliberately. Everything else is
 * derived from the picked source entry and overridable by flag, so the
 * happy path is one command with no required metadata arguments.
 */

import type { ConvertIdentityOverrides } from "./types"

/** Resolved identity fields, ready to stamp into a manifest. */
export interface ResolvedIdentity {
  id: string
  name: string
  description: string
  version: string
  author: string
  authorEmail?: string
  license: string
  minAppVersion: string
}

/** Fallbacks used when neither the source nor the author supplies a value. */
export interface IdentityDefaults {
  /** Source-derived id stem, e.g. the MCP server name or skill folder. */
  stem: string
  /** Source-derived display name. */
  name: string
  /** Source-derived one-liner. */
  description: string
  /** Suffix appended to the slug so ids read as `<stem>-mcp` / `-skill`. */
  suffix: string
  /** Host version to record as `minAppVersion` when not overridden. */
  hostVersion: string
  /** `author` when the caller could not read one from git config. */
  author?: string
}

const DEFAULT_VERSION = "0.1.0"
const DEFAULT_LICENSE = "MIT"
const DEFAULT_AUTHOR = "unknown"

/**
 * Lowercase a string into a manifest-safe id segment.
 *
 * The host's id rule (`validation.ts`) is "alphanumeric start, then
 * alphanumerics / hyphen / underscore / dot", so every other character
 * collapses to a hyphen and leading non-alphanumerics are dropped.
 */
export function slugify(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
  return slug
}

/**
 * Build the generated plugin's id: `<slug>-<suffix>`, unless the slug
 * already ends with that suffix (so an MCP entry literally named
 * `playwright-mcp` does not become `playwright-mcp-mcp`).
 */
export function deriveId(stem: string, suffix: string): string {
  const slug = slugify(stem)
  if (!slug) throw new Error(`cannot derive a plugin id from "${stem}" — pass --id`)
  if (slug === suffix || slug.endsWith(`-${suffix}`)) return slug
  return `${slug}-${suffix}`
}

/** Title-case a slug for display: `demo-delivery` → `Demo Delivery`. */
export function titleize(raw: string): string {
  return slugify(raw)
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * Merge source-derived defaults with author overrides. Overrides always
 * win; blank overrides are treated as absent so an empty `--author ""`
 * cannot produce an empty manifest field.
 */
export function resolveIdentity(
  defaults: IdentityDefaults,
  overrides: ConvertIdentityOverrides = {}
): ResolvedIdentity {
  const pick = (override: string | undefined, fallback: string): string => {
    const trimmed = override?.trim()
    return trimmed ? trimmed : fallback
  }

  const id = pick(overrides.id, deriveId(defaults.stem, defaults.suffix))
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error(
      `plugin id "${id}" is invalid — it must start with a letter or digit and contain only letters, digits, ".", "-", or "_"`
    )
  }

  const authorEmail = overrides.authorEmail?.trim()
  return {
    id,
    name: pick(overrides.name, defaults.name || titleize(defaults.stem)),
    description: pick(overrides.description, defaults.description),
    version: pick(overrides.version, DEFAULT_VERSION),
    author: pick(overrides.author, defaults.author?.trim() || DEFAULT_AUTHOR),
    authorEmail: authorEmail || undefined,
    license: pick(overrides.license, DEFAULT_LICENSE),
    minAppVersion: pick(overrides.minAppVersion, defaults.hostVersion),
  }
}
