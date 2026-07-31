/**
 * Assemble the generated `plugin.json`.
 *
 * Every converted plugin is `type: "frontend"` with `main: "dist/index.js"`.
 * There is no data-only plugin type — `validation.ts` requires a runtime
 * entry for frontend plugins — but all three converted capabilities
 * (`mcp-server-preset`, `skills`, `cli-tools`) are dispatched from the
 * manifest by the host (`capability-bridge-map.ts` for the first two,
 * `PluginManager` for `cliTools`). So the entry file stays an empty shell
 * and the manifest is the single source of truth; the generated project
 * deliberately does NOT repeat the manifest inside the entry the way some
 * first-party plugins do.
 *
 * `runtimeCompatibility` is derived mechanically from what the
 * contribution actually needs at runtime, not guessed:
 *
 * | contribution                | browser | tauri | mobile |
 * | --------------------------- | ------- | ----- | ------ |
 * | stdio MCP preset            | blocked | ok    | blocked|
 * | http / sse MCP preset       | ok      | ok    | ok     |
 * | inline skill                | ok      | ok    | ok     |
 * | local-bundle skill          | blocked | ok    | blocked|
 * | cli tools                   | blocked | ok    | blocked|
 *
 * The blocked rows are facts, not caution: a stdio server is spawned as a
 * host process, `resolveSkillMarkdown` reads bundle skills through
 * `@tauri-apps/plugin-fs`, and `cliTools` execute host binaries.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  PluginRuntimeCompatibilityMap,
  PluginRuntimeCompatibilityTarget,
} from "@/types/plugin/plugin"
import type { ResolvedIdentity } from "./identity"

/** Entry point every converted plugin builds to. */
export const CONVERTED_MAIN = "dist/index.js"

/** What the contribution needs from the host at runtime. */
export type RuntimeNeed = "host-process" | "host-filesystem" | "portable"

const SUPPORTED: PluginRuntimeCompatibilityTarget = {
  availability: "supported",
  entrypoint: CONVERTED_MAIN,
}

function blocked(reason: string): PluginRuntimeCompatibilityTarget {
  return { availability: "blocked", reason }
}

const BLOCK_REASONS: Record<Exclude<RuntimeNeed, "portable">, string> = {
  "host-process": "Spawns a local host process; desktop only.",
  "host-filesystem": "Reads files from the plugin directory through the desktop filesystem bridge.",
}

/** Build the compatibility map for a contribution with the given need. */
export function deriveRuntimeCompatibility(need: RuntimeNeed): PluginRuntimeCompatibilityMap {
  if (need === "portable") {
    return { browser: SUPPORTED, tauri: SUPPORTED, mobile: SUPPORTED }
  }
  const reason = BLOCK_REASONS[need]
  return { browser: blocked(reason), tauri: SUPPORTED, mobile: blocked(reason) }
}

/** Everything the assembler needs beyond identity. */
export interface ManifestAssembly {
  identity: ResolvedIdentity
  capabilities: string[]
  permissions?: string[]
  need: RuntimeNeed
  /** Contribution arrays merged verbatim into the manifest. */
  contributions: Partial<PluginManifest>
}

/**
 * Produce the manifest object. Key order is chosen for readability in the
 * generated file (identity, then runtime, then contributions) because the
 * author reads and edits this file by hand.
 */
export function assembleManifest(assembly: ManifestAssembly): PluginManifest {
  const { identity, capabilities, permissions, need, contributions } = assembly
  const author: PluginManifest["author"] = identity.authorEmail
    ? { name: identity.author, email: identity.authorEmail }
    : { name: identity.author }

  const manifest = {
    id: identity.id,
    name: identity.name,
    version: identity.version,
    description: identity.description,
    type: "frontend",
    capabilities,
    main: CONVERTED_MAIN,
    author,
    license: identity.license,
    minAppVersion: identity.minAppVersion,
    engines: { cognia: `>=${identity.minAppVersion}` },
    permissions: permissions ?? [],
    activationEvents: ["startup"],
    runtimeCompatibility: deriveRuntimeCompatibility(need),
    ...contributions,
  } as unknown as PluginManifest

  return manifest
}

/** Serialize a manifest the way the repo's other `plugin.json` files read. */
export function serializeManifest(manifest: PluginManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
