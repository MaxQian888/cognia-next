/**
 * Which ecosystem a plugin bundle is written for.
 *
 * Bundles increasingly carry several manifests at once (a repo published to
 * Claude Code and Factory Droid ships `.claude-plugin/` AND `.factory-plugin/`;
 * a portable Agent Plugins root `plugin.json` often sits next to a legacy
 * `.claude-plugin/`). Detection picks the MOST SPECIFIC vendor manifest and
 * reports the others as shadowed, so the conversion report can say which
 * declarations were not read. Two different vendor-specific manifests are
 * still ambiguous: nothing says which host the author meant.
 *
 * Precedence (tier 0 wins; within the generic tier the order is the Agent
 * Plugins §5.1 / Copilot / OpenHands read order):
 *
 * | Tier | Marker                                              | Ecosystem      |
 * | ---- | --------------------------------------------------- | -------------- |
 * | 0    | root `plugin.json` with `id` + `type`               | cognia         |
 * | 1    | `.devin-plugin/plugin.json`                         | devin          |
 * | 1    | `.factory-plugin/plugin.json`                       | factory-droid  |
 * | 1    | `.qoder-plugin/plugin.json`                         | qoder          |
 * | 1    | `.codebuddy-plugin/` or `.workbuddy-plugin/plugin.json` | codebuddy  |
 * | 1    | `.augment-plugin/plugin.json`                       | auggie         |
 * | 1    | `.cursor-plugin/plugin.json`                        | cursor         |
 * | 1    | `.codex-plugin/plugin.json`                         | codex          |
 * | 1    | `.github/plugin/plugin.json`                        | copilot        |
 * | 1    | `.goose-plugin/plugin.json`                         | open-plugins   |
 * | 1    | `gemini-extension.json`                             | gemini-cli     |
 * | 1    | `opencode.json` / `opencode.jsonc`                  | opencode       |
 * | 1    | `package.json` with a `pi` key or `pi-package` keyword | pi          |
 * | 1    | root `plugin.json`, no `$schema`, Kimi keys (`tools`, `inject`, `config_file`) | kimi |
 * | 1    | root `plugin.json`, no `$schema`, otherwise         | copilot (legacy root manifest) |
 * | 2    | root `plugin.json` with an agent-plugins.org `$schema` | agent-plugins |
 * | 2    | `.plugin/plugin.json`                               | open-plugins   |
 * | 2    | `.claude-plugin/plugin.json`                        | claude-code    |
 * | 3    | root `plugin.json` with an `id` but no `type` (Cognia draft) | cognia  |
 *
 * A marker whose contents are exactly `{}` is a neutralized leftover from an
 * earlier conversion and only counts when nothing else does.
 */

import type { PluginDeliveryTarget } from "./delivery"

type Ecosystem = PluginDeliveryTarget
type Files = ReadonlyMap<string, string>

export interface DetectedPluginBundle {
  ecosystem: Ecosystem
  /** The manifest that decided the ecosystem (absent for none). */
  manifestPath?: string
  /** Other recognized manifests the selected host would not read. */
  shadowed: Array<{ path: string; ecosystem: Ecosystem }>
}

/** Every vendor manifest path; neutralized on import so raw configs never survive. */
export const VENDOR_MANIFEST_PATHS = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".devin-plugin/plugin.json",
  ".factory-plugin/plugin.json",
  ".qoder-plugin/plugin.json",
  ".codebuddy-plugin/plugin.json",
  ".workbuddy-plugin/plugin.json",
  ".augment-plugin/plugin.json",
  ".goose-plugin/plugin.json",
  ".plugin/plugin.json",
  ".github/plugin/plugin.json",
  "gemini-extension.json",
] as const

const VENDOR_DIRECTORY_MARKERS: ReadonlyArray<[string, Ecosystem]> = [
  [".devin-plugin/plugin.json", "devin"],
  [".factory-plugin/plugin.json", "factory-droid"],
  [".qoder-plugin/plugin.json", "qoder"],
  [".codebuddy-plugin/plugin.json", "codebuddy"],
  [".workbuddy-plugin/plugin.json", "codebuddy"],
  [".augment-plugin/plugin.json", "auggie"],
  [".cursor-plugin/plugin.json", "cursor"],
  [".codex-plugin/plugin.json", "codex"],
  [".github/plugin/plugin.json", "copilot"],
  [".goose-plugin/plugin.json", "open-plugins"],
  ["gemini-extension.json", "gemini-cli"],
  ["opencode.json", "opencode"],
  ["opencode.jsonc", "opencode"],
]

const GENERIC_MARKERS: ReadonlyArray<[string, Ecosystem]> = [
  [".plugin/plugin.json", "open-plugins"],
  [".claude-plugin/plugin.json", "claude-code"],
]

export const AGENT_PLUGINS_SCHEMA_PREFIX = "https://agent-plugins.org/schemas/"

const KIMI_KEYS = ["tools", "inject", "config_file"]

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function neutralized(text: string | undefined): boolean {
  return text !== undefined && /^\s*\{\s*\}\s*$/.test(text)
}

/** Classify the root `plugin.json`, which four ecosystems share. */
function classifyRootManifest(text: string): { ecosystem: Ecosystem; tier: 0 | 1 | 2 | 3 } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `could not parse plugin.json: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("plugin.json must contain a JSON object")
  const root = parsed as Record<string, unknown>
  if (typeof root.id === "string" && typeof root.type === "string")
    return { ecosystem: "cognia", tier: 0 }
  if (typeof root.$schema === "string") {
    if (root.$schema.startsWith(AGENT_PLUGINS_SCHEMA_PREFIX))
      return { ecosystem: "agent-plugins", tier: 2 }
    throw new Error("plugin.json schema is not a recognized Cognia or Agent Plugins format")
  }
  if (KIMI_KEYS.some((key) => key in root)) return { ecosystem: "kimi", tier: 1 }
  // A Cognia manifest that is still being authored may lack `type`; its `id`
  // (which no foreign manifest has) keeps it Cognia when nothing else matches.
  if (typeof root.id === "string") return { ecosystem: "cognia", tier: 3 }
  return { ecosystem: "copilot", tier: 1 }
}

function isPiPackage(text: string | undefined): boolean {
  const pkg = parseObject(text)
  if (!pkg) return false
  return (
    (pkg.pi !== null && typeof pkg.pi === "object" && !Array.isArray(pkg.pi)) ||
    (Array.isArray(pkg.keywords) && pkg.keywords.includes("pi-package"))
  )
}

/** Detect the bundle's ecosystem and the manifests it shadows. */
export function detectPluginBundle(files: Files): DetectedPluginBundle {
  const candidates: Array<{ path: string; ecosystem: Ecosystem; tier: 0 | 1 | 2 | 3 }> = []
  const rootText = files.get("plugin.json")
  if (rootText !== undefined && !neutralized(rootText)) {
    const root = classifyRootManifest(rootText)
    // The canonical Cognia identity wins over inert overlay markers.
    if (root.ecosystem === "cognia" && root.tier === 0)
      return { ecosystem: "cognia", manifestPath: "plugin.json", shadowed: [] }
    candidates.push({ path: "plugin.json", ...root })
  }
  for (const [path, ecosystem] of VENDOR_DIRECTORY_MARKERS)
    if (files.has(path)) candidates.push({ path, ecosystem, tier: 1 })
  if (isPiPackage(files.get("package.json")))
    candidates.push({ path: "package.json", ecosystem: "pi", tier: 1 })
  for (const [path, ecosystem] of GENERIC_MARKERS)
    if (files.has(path)) candidates.push({ path, ecosystem, tier: 2 })

  const active = candidates.filter((candidate) => !neutralized(files.get(candidate.path)))
  const pool = active.length ? active : candidates
  if (pool.length === 0) {
    if (rootText !== undefined)
      return { ecosystem: "cognia", manifestPath: "plugin.json", shadowed: [] }
    throw new Error(
      "plugin format not recognized — provide a Cognia, Agent Plugins, Claude Code, Codex, Gemini, Cursor, Copilot, Kimi, Devin, OpenCode, Pi, Factory Droid, Qoder, CodeBuddy, Auggie or Open Plugins bundle"
    )
  }
  const bestTier = Math.min(...pool.map((candidate) => candidate.tier))
  const winners = pool.filter((candidate) => candidate.tier === bestTier)
  const ecosystems = [...new Set(winners.map((candidate) => candidate.ecosystem))]
  // Two vendor-specific manifests name two different hosts: refuse to guess.
  if (bestTier < 2 && ecosystems.length > 1)
    throw new Error(
      `multiple plugin formats found (${winners.map((candidate) => candidate.path).join(", ")}); provide one unambiguous plugin bundle`
    )
  // Generic tier: the first marker in read order decides; later ones are shadowed.
  const ordered =
    bestTier === 2
      ? [
          ...winners.filter((candidate) => candidate.ecosystem === "agent-plugins"),
          ...winners.filter((candidate) => candidate.path === ".plugin/plugin.json"),
          ...winners.filter((candidate) => candidate.path === ".claude-plugin/plugin.json"),
        ]
      : winners
  const selected = ordered[0]
  const resolved = selected.ecosystem
  return {
    ecosystem: resolved,
    manifestPath: selected.path,
    shadowed: active
      .filter((candidate) => candidate.path !== selected.path)
      .map(({ path, ecosystem: shadowedEcosystem }) => ({ path, ecosystem: shadowedEcosystem })),
  }
}
