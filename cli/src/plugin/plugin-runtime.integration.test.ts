/**
 * @jest-environment node
 *
 * Integration test: the REAL headless plugin bootstrap. Boots the actual
 * `PluginManager` + `usePluginStore` (no mocks) the way the CLI session-runner
 * does, and asserts the in-tree first-party plugins load, contribute a tools
 * manifest, and that a tool resolves + executes through the live registry
 * without stalling on the consent broker. Isolated in its own file so the global
 * plugin-manager singleton it creates does not leak into other suites.
 */
import { ensurePluginRuntime, __resetPluginRuntimeForTesting } from "./plugin-runtime"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-plugin-runtime-"))
const previousCogniaHome = process.env.COGNIA_HOME

describe("plugin runtime (real bootstrap)", () => {
  beforeEach(() => {
    process.env.COGNIA_HOME = testHome
    __resetPluginRuntimeForTesting()
  })

  // Some in-tree plugins (scheduler, share-watch) start background timers on
  // activation. Disable every enabled plugin so the worker can exit cleanly.
  afterAll(async () => {
    try {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      const { usePluginStore } = await import("@/stores/plugin-runtime")
      const manager = getPluginManager()
      for (const [id, p] of Object.entries(usePluginStore.getState().plugins)) {
        if ((p as { status?: string }).status === "enabled") {
          await manager.disablePlugin(id, "test-teardown").catch(() => {})
        }
      }
    } catch {
      // best-effort
    }
    if (previousCogniaHome === undefined) delete process.env.COGNIA_HOME
    else process.env.COGNIA_HOME = previousCogniaHome
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  it("loads in-tree plugins, builds a tools manifest, and resolves a tool handler", async () => {
    const result = await ensurePluginRuntime()
    expect(result.ok).toBe(true)
    // web-tools (3) + workspace-tools (4) + others — comfortably > 5.
    expect(result.toolCount).toBeGreaterThan(5)

    const { buildPluginToolsManifest } = await import("@/lib/plugin/bridge/sidecar-tools-bridge")
    const names = buildPluginToolsManifest({}).map((m) => m.name)
    // cognia-web-tools works headless (uses fetch, not Tauri) — its tools must
    // be present so the CLI agent can actually fetch/search the web.
    expect(names).toContain("web_fetch")
    expect(names).toContain("web_research")

    // The execution path: the tool resolves in the live registry (so
    // handlePluginToolExec → invokePluginTool can run it) without a consent stall.
    const { resolvePluginToolByName, invokePluginTool } =
      await import("@/lib/plugin/core/invoke-plugin-tool")
    const resolved = await resolvePluginToolByName("workspace_list_files")
    expect(resolved?.pluginId).toBe("cognia-workspace-tools")
    const exec = await Promise.race([
      invokePluginTool(
        resolved!.pluginId,
        "workspace_list_files",
        { path: "." },
        {
          sessionId: "it",
          reason: "integration-test",
        }
      ).then(() => "executed"),
      new Promise<string>((r) => setTimeout(() => r("stalled"), 5000)),
    ])
    // It executes (returns) rather than stalling on the consent gate; the tool's
    // own result may be a desktop-only error, which is fine — we assert no stall.
    expect(exec).toBe("executed")
  }, 30000)
})
