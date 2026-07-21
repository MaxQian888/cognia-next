/**
 * Acceptance: a plugin produced by `cognia plugin import` is actually
 * consumed by the host.
 *
 * The chronic failure mode in this codebase is a feature that is fully
 * built and never reached at runtime, so "the generated JSON looks right"
 * is not a sufficient bar. This suite drives the real path end to end:
 *
 *   1. `convert()` produces the project file map.
 *   2. `healthcheckScaffold` — the repo's own pre-write scaffold validator,
 *      which had no production caller until now — checks the map.
 *   3. `validatePluginManifest` — the exact validator the installer runs —
 *      accepts the generated `plugin.json`.
 *   4. `PluginManager.registerPluginContributions` (the real private method,
 *      not a reimplementation of its loop) registers the plugin, and the
 *      real overlay registries are asserted to hold the entries.
 *
 * Step 4 is what proves the wiring. It also pins the `installRoot` plumbing:
 * a `local-bundle` skill's plugin-dir-relative path must come out of the
 * registry anchored to the plugin's install directory.
 */

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))

jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: jest.fn(), subscribe: jest.fn() },
}))

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: { getState: jest.fn() },
}))

jest.mock("@/lib/plugin/security/signature", () => ({
  getPluginSignatureVerifier: jest.fn(),
}))

jest.mock("@/lib/plugin/security/permission-guard", () => ({
  getPermissionGuard: jest.fn(),
  createGuardedAPI: jest.fn((_pluginId: string, api: unknown) => api),
}))

jest.mock("@/lib/plugin/security/consent-broker", () => {
  const broker = { clearSessionGrantsForPlugin: jest.fn() }
  return { getPluginConsentBroker: () => broker }
})

jest.mock("@/lib/native/utils", () => ({
  canUseTauriInvoke: jest.fn(() => false),
  isTauri: jest.fn(() => false),
}))

jest.mock("@/lib/chat/slash-command-registry", () => ({
  getSlashCommand: jest.fn(),
  registerSlashCommand: jest.fn(),
  unregisterSlashCommand: jest.fn(),
}))

// Dexie-backed modules the contributions path dynamic-imports; there is no
// IndexedDB in this environment.
jest.mock("@/lib/db/characters", () => ({
  getCharacter: jest.fn(async () => undefined),
  updateCharacter: jest.fn(async () => undefined),
  listCharacters: jest.fn(async () => []),
}))

jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(async () => undefined),
  updatePlugin: jest.fn(async () => undefined),
  upsertPlugin: jest.fn(async () => undefined),
}))

import { usePluginStore } from "@/stores/plugin-runtime"
import { getPluginSignatureVerifier } from "@/lib/plugin/security/signature"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { PluginManager } from "@/lib/plugin/core/manager"
import { validatePluginManifest } from "@/lib/plugin/core/validation"
import { healthcheckScaffold } from "@/lib/plugin/utils/scaffold-healthcheck"
import {
  getMcpServerPreset,
  __resetMcpServerPresetsForTesting,
} from "@/lib/plugin/registries/mcp-server-preset-registry"
import { getSkill, __resetSkillsForTesting } from "@/lib/plugin/registries/skill-registry"
import { convert } from "./index"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { ConvertResult } from "./types"

const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    github: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "ghp_live_secret" },
    },
  },
})

const SKILL_MD = `---
name: Code Review
description: Review a diff.
---

Read the diff, report findings.
`

const INSTALL_ROOT = "/home/u/.cognia/plugins/generated"

/** Parse the generated plugin.json the way the installer does. */
function readManifest(result: ConvertResult): PluginManifest {
  return JSON.parse(result.files.get("plugin.json")!) as PluginManifest
}

/**
 * Run the host's real contribution dispatch for a generated manifest.
 * Mirrors an install: the plugin sits at `INSTALL_ROOT` and is enabled.
 */
async function registerWithHost(manifest: PluginManifest): Promise<void> {
  const store = {
    plugins: {
      [manifest.id]: {
        manifest,
        status: "enabled",
        source: "local",
        path: INSTALL_ROOT,
        config: {},
      },
    },
    registerPluginMode: jest.fn(),
    registerPluginCommand: jest.fn(),
    registerPluginTool: jest.fn(),
  }
  ;(usePluginStore.getState as unknown as jest.Mock).mockReturnValue(store)

  const manager = new PluginManager({ pluginDirectory: "/plugins" })
  const internals = manager as unknown as {
    contexts: Map<string, unknown>
    registerPluginContributions: (pluginId: string) => Promise<void>
  }
  internals.contexts.set(manifest.id, {
    pluginId: manifest.id,
    permissions: { hasPermission: () => true },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  })
  await internals.registerPluginContributions(manifest.id)
}

beforeEach(() => {
  ;(getPluginSignatureVerifier as jest.Mock).mockReturnValue({
    verify: jest.fn(async () => ({ valid: true })),
    getConfig: jest.fn(() => ({ requireSignatures: false, allowUntrusted: true })),
  })
  ;(getPermissionGuard as jest.Mock).mockReturnValue({
    registerPlugin: jest.fn(),
    unregisterPlugin: jest.fn(),
    getPluginPermissions: jest.fn(() => []),
    getTier: jest.fn(() => "silent"),
  })
})

afterEach(() => {
  __resetMcpServerPresetsForTesting()
  __resetSkillsForTesting()
  jest.clearAllMocks()
})

describe("generated MCP plugin", () => {
  const result = convert(
    { kind: "mcp", text: MCP_CONFIG, sourceName: ".cursor/mcp.json", pick: "github" },
    { hostVersion: "0.1.0", gitAuthor: "Ada" }
  )

  it("passes the repo's scaffold healthcheck with zero findings", () => {
    // Clean only because the project ships the file `main` points at.
    // Without the pre-generated `dist/index.js` this reports
    // `main_missing`, which is exactly the state in which the plugin
    // cannot be installed.
    const report = healthcheckScaffold(result.files)
    expect(report.issues).toEqual([])
    expect(report.ok).toBe(true)
  })

  it("passes the same manifest validator the installer runs", () => {
    const validation = validatePluginManifest(readManifest(result))
    expect(validation.errors).toEqual([])
    expect(validation.valid).toBe(true)
  })

  it("registers into the real MCP preset registry when the host enables it", async () => {
    const manifest = readManifest(result)
    expect(getMcpServerPreset("github")).toBeUndefined()

    await registerWithHost(manifest)

    const preset = getMcpServerPreset("github")
    expect(preset).toBeDefined()
    expect(preset?.transport).toBe("stdio")
    expect(preset?.config).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "" },
    })
  })

  it("carries the user-filled field declaration through to the host", async () => {
    await registerWithHost(readManifest(result))
    expect(getMcpServerPreset("github")?.fields).toEqual([
      { key: "GITHUB_TOKEN", label: "Github token", placement: "env", secret: true },
    ])
  })

  it("puts no credential in front of the host", async () => {
    await registerWithHost(readManifest(result))
    expect(JSON.stringify(getMcpServerPreset("github"))).not.toContain("ghp_live_secret")
  })
})

describe("generated inline-skill plugin", () => {
  const result = convert({ kind: "skill", text: SKILL_MD, sourceName: "cr" })

  it("passes the installer's manifest validator", () => {
    expect(validatePluginManifest(readManifest(result)).errors).toEqual([])
  })

  it("registers into the real skill registry with its body intact", async () => {
    await registerWithHost(readManifest(result))
    const skill = getSkill("code-review")
    expect(skill?.name).toBe("Code Review")
    expect(skill?.source).toEqual({
      kind: "inline",
      markdown: expect.stringContaining("Read the diff"),
    })
  })
})

describe("generated bundle-skill plugin", () => {
  const result = convert({
    kind: "skill",
    text: SKILL_MD,
    sourceName: "cr",
    resources: ["references/checklist.md"],
  })

  it("ships a plugin-dir-relative path in the manifest", () => {
    expect(readManifest(result).skills?.[0].source).toEqual({
      kind: "local-bundle",
      path: "skills/code-review",
    })
  })

  it("comes out of the host registry anchored to the install directory", async () => {
    await registerWithHost(readManifest(result))
    // This is the PR-0 fix observed end to end: what the author wrote as a
    // relative path is what `resolveSkillMarkdown` can actually read.
    expect(getSkill("code-review")?.source).toEqual({
      kind: "local-bundle",
      path: `${INSTALL_ROOT}/skills/code-review`,
    })
  })
})

describe("generated CLI skeleton plugin", () => {
  const result = convert({ kind: "cli", binary: "rg" })

  it("is structurally valid but reported as unfinished, with no new lint rule", () => {
    const validation = validatePluginManifest(readManifest(result))
    expect(validation.errors).toEqual([])
    expect(validation.diagnostics.map((d) => d.code)).toContain("manifest.capability.field_missing")
  })

  it("contributes nothing to the host until the author fills the table in", async () => {
    const store = { plugins: {}, registerPluginTool: jest.fn() }
    ;(usePluginStore.getState as unknown as jest.Mock).mockReturnValue(store)
    await registerWithHost(readManifest(result))
    expect(store.registerPluginTool).not.toHaveBeenCalled()
  })
})
