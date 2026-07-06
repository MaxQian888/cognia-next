// Pure helpers for the clonedeps manifest (`.cognia/clonedeps.json`) and the
// derived clone workspace layout. No I/O — `clone.mjs` owns the filesystem and
// git side effects. Mirrors oh-my-opencode-slim's `.slim/clonedeps.json` design.

import path from "node:path"

export const MANIFEST_VERSION = "1.0.0"
/** Safety cap (omo-slim default): never let the workspace balloon past this. */
export const MAX_DEPENDENCIES = 5

/** Relative locations under the repo root. */
export const CLONEDEPS_DIR = path.join(".cognia", "clonedeps")
export const REPOS_DIR = path.join(CLONEDEPS_DIR, "repos")
export const MANIFEST_REL = path.join(".cognia", "clonedeps.json")
/** Path, relative to the repo root, that the .gitignore marker block ignores. */
export const REPOS_IGNORE_PATTERN = "/.cognia/clonedeps/repos/"

/** @returns {{ version: string, updatedAt: string, dependencies: any[] }} */
export function emptyManifest() {
  return { version: MANIFEST_VERSION, updatedAt: "", dependencies: [] }
}

/**
 * Parse manifest JSON tolerantly — a malformed or partial file degrades to an
 * empty manifest rather than throwing (the workspace is reference data, not a
 * source of truth we must trust).
 * @param {string} text
 * @returns {{ version: string, updatedAt: string, dependencies: any[] }}
 */
export function parseManifest(text) {
  if (typeof text !== "string" || text.trim().length === 0) return emptyManifest()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyManifest()
  }
  if (!parsed || typeof parsed !== "object") return emptyManifest()
  const dependencies = Array.isArray(parsed.dependencies)
    ? parsed.dependencies.filter((d) => d && typeof d === "object" && typeof d.repoUrl === "string")
    : []
  return {
    version: typeof parsed.version === "string" ? parsed.version : MANIFEST_VERSION,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    dependencies,
  }
}

/**
 * Derive a filesystem-safe folder name from a repo URL: `owner__repo` from the
 * last two path segments, lowercased, with unsafe chars collapsed to `-`.
 * Example: `https://github.com/opencode-ai/opencode.git` → `opencode-ai__opencode`.
 * @param {string} repoUrl
 * @returns {string}
 */
export function safeRepoName(repoUrl) {
  if (typeof repoUrl !== "string" || repoUrl.trim().length === 0) {
    throw new Error("repoUrl must be a non-empty string")
  }
  let rest = repoUrl.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") // strip scheme
  // Trailing slashes first, then the `.git` suffix (some URLs carry both).
  rest = rest
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
  const segments = rest.split("/").filter(Boolean)
  // Drop the host (first segment) when present; keep the last two path parts.
  const pathParts = segments.length > 2 ? segments.slice(1) : segments
  const owner = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : ""
  const repo = pathParts[pathParts.length - 1] ?? ""
  const joined = [owner, repo].filter(Boolean).join("__") || "repo"
  return joined
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Reject anything but an HTTPS git URL (omo-slim safety default — no SSH, no
 * plain HTTP, no local file paths).
 * @param {string} repoUrl
 * @returns {boolean}
 */
export function isHttpsRepoUrl(repoUrl) {
  return typeof repoUrl === "string" && /^https:\/\/[^\s]+$/i.test(repoUrl.trim())
}

/**
 * Insert or replace a dependency entry (keyed by `path` + `packagePath`, so two
 * packages from one monorepo coexist). Enforces MAX_DEPENDENCIES for genuinely
 * new entries; re-adding an existing entry never trips the cap.
 * @param {ReturnType<typeof emptyManifest>} manifest
 * @param {{ name?: string, repoUrl: string, ref?: string, path: string, packagePath?: string, reason?: string, resolvedVersion?: string }} dep
 * @param {string} nowIso
 * @returns {ReturnType<typeof emptyManifest>}
 */
export function upsertDependency(manifest, dep, nowIso) {
  const base = manifest ?? emptyManifest()
  const keyOf = (d) => `${d.path}::${d.packagePath ?? ""}`
  const incomingKey = keyOf(dep)
  const existingIdx = base.dependencies.findIndex((d) => keyOf(d) === incomingKey)

  if (existingIdx === -1 && base.dependencies.length >= MAX_DEPENDENCIES) {
    throw new Error(
      `clonedeps manifest already tracks ${MAX_DEPENDENCIES} dependencies (the safety cap). ` +
        "Remove an entry from .cognia/clonedeps.json before adding another."
    )
  }

  const cleaned = {
    name: dep.name,
    resolvedVersion: dep.resolvedVersion,
    repoUrl: dep.repoUrl,
    ref: dep.ref,
    path: dep.path,
    packagePath: dep.packagePath,
    reason: dep.reason,
  }
  // Drop undefined fields so the serialized manifest stays compact.
  for (const k of Object.keys(cleaned)) {
    if (cleaned[k] === undefined) delete cleaned[k]
  }

  const dependencies = base.dependencies.slice()
  if (existingIdx === -1) dependencies.push(cleaned)
  else dependencies[existingIdx] = cleaned

  return { version: MANIFEST_VERSION, updatedAt: nowIso, dependencies }
}

/** Serialize a manifest with a trailing newline (git-friendly). */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
