// Project / toolchain auto-detection ("自适应" #1).
//
// Given the agent cwd (already resolved by the renderer's cwd chain at
// `lib/claude/build-options.ts:643` and delivered as `SendOptions.cwd`),
// detect language(s), package manager, and frameworks from root markers
// and lockfiles. Drives which language servers are eligible and a short
// system-prompt snippet so the model adapts up front.
//
// Pure `fs` reads, no spawning — safe to run lazily on first need.

import fs from "node:fs"
import path from "node:path"

function has(dir, name) {
  try {
    return fs.existsSync(path.join(dir, name))
  } catch {
    return false
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"))
  } catch {
    return null
  }
}

/**
 * @typedef {Object} Toolchain
 * @property {string[]} languages   Detected languages (monaco-ish ids).
 * @property {string | null} packageManager  npm|pnpm|yarn|bun|cargo|go|uv|pip|null
 * @property {string[]} frameworks  e.g. ["next","tailwind"].
 * @property {boolean} typescript   tsconfig present.
 */

/**
 * @param {string} cwd
 * @returns {Toolchain}
 */
export function detectToolchain(cwd) {
  const dir = path.resolve(cwd)
  const languages = new Set()
  const frameworks = new Set()
  let packageManager = null

  // Node / JS / TS
  if (has(dir, "package.json")) {
    languages.add("javascript")
    if (has(dir, "pnpm-lock.yaml")) packageManager = "pnpm"
    else if (has(dir, "yarn.lock")) packageManager = "yarn"
    else if (has(dir, "bun.lockb") || has(dir, "bun.lock")) packageManager = "bun"
    else if (has(dir, "package-lock.json")) packageManager = "npm"
    else packageManager = "npm"

    const pkg = readJsonSafe(path.join(dir, "package.json")) ?? {}
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    if (deps.next) frameworks.add("next")
    if (deps.react) frameworks.add("react")
    if (deps.vue) frameworks.add("vue")
    if (deps.svelte) frameworks.add("svelte")
    if (deps.tailwindcss) frameworks.add("tailwind")
    if (deps.vitest || deps.jest) frameworks.add("test")
  }
  if (has(dir, "tsconfig.json")) languages.add("typescript")

  // Rust
  if (has(dir, "Cargo.toml")) {
    languages.add("rust")
    if (!packageManager) packageManager = "cargo"
  }

  // Go
  if (has(dir, "go.mod") || has(dir, "go.work")) {
    languages.add("go")
    if (!packageManager) packageManager = "go"
  }

  // Python
  if (
    has(dir, "pyproject.toml") ||
    has(dir, "setup.py") ||
    has(dir, "requirements.txt") ||
    has(dir, "Pipfile")
  ) {
    languages.add("python")
    if (!packageManager) {
      if (has(dir, "uv.lock")) packageManager = "uv"
      else if (has(dir, "Pipfile")) packageManager = "pip"
      else packageManager = "pip"
    }
  }

  return {
    languages: [...languages],
    packageManager,
    frameworks: [...frameworks],
    typescript: has(dir, "tsconfig.json"),
  }
}

/**
 * Build a one-line system-prompt snippet from a detected toolchain.
 * Returns null when nothing was detected (so callers can skip injection).
 *
 * @param {Toolchain} tc
 * @returns {string | null}
 */
export function toolchainPromptSnippet(tc) {
  if (!tc || (tc.languages.length === 0 && !tc.packageManager)) return null
  const parts = []
  if (tc.packageManager) parts.push(tc.packageManager)
  if (tc.languages.length) parts.push(tc.languages.join("/"))
  if (tc.frameworks.length) parts.push(tc.frameworks.join("+"))
  return `Detected project toolchain: ${parts.join(" · ")}.`
}
