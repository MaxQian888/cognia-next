/**
 * Covers the default dependency wiring of executeCliTool (no test
 * override): guard + broker + detect-cli + policy + Tauri invoke + Dexie
 * audit + workspace-root lookup all resolve through their real module
 * seams (mocked here at the module boundary).
 */

const checkWithConsentMock = jest.fn(async () => true)
jest.mock("@/lib/plugin/security/permission-guard", () => ({
  getPermissionGuard: () => ({ checkWithConsent: checkWithConsentMock }),
}))

const brokerRequestMock = jest.fn(async () => true)
jest.mock("@/lib/plugin/security/consent-broker", () => ({
  getPluginConsentBroker: () => ({ request: brokerRequestMock }),
}))

const detectCliMock = jest.fn(async () => ({
  available: true,
  version: "14.1.0",
  path: "C:/bin/rg.exe",
  error: null,
}))
jest.mock("@/lib/cli-bridge/detect-cli", () => ({
  detectCli: detectCliMock,
  satisfiesMinVersion: () => true,
}))

const evaluateCliBinaryMock = jest.fn(async () => ({
  allowed: true,
  requiresPrompt: false,
  reason: "trusted",
}))
jest.mock("./cli-binary-policy", () => ({
  evaluateCliBinary: evaluateCliBinaryMock,
}))

const invokeMock = jest.fn(async () => ({
  stdout: "found\n",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  truncated: false,
}))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

const auditAddMock = jest.fn(async () => undefined)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ automationAuditLog: { add: auditAddMock } }),
}))

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: {
    getState: () => ({
      activeProjectId: "p1",
      projects: [{ id: "p1", roots: [{ path: "C:/work/repo", isPrimary: true }] }],
    }),
  },
}))

jest.mock("@/lib/workspace/roots", () => ({
  primaryRootOf: (project: { roots?: Array<{ path: string }> }) => project.roots?.[0],
}))

import { executeCliTool } from "./execute-cli-tool"
import type { PluginCliToolDef } from "@/types/plugin"

const TOOL: PluginCliToolDef = {
  name: "ripgrep_search",
  description: "Search",
  parameters: { type: "object", properties: { pattern: { type: "string" } } },
  binary: { kind: "requires", name: "rg" },
  argv: [{ param: "pattern" }],
  cwd: { kind: "workspace" },
}

describe("executeCliTool default deps", () => {
  it("wires guard, detect, invoke, audit, and the workspace root", async () => {
    const result = await executeCliTool(
      "ripgrep-tools",
      TOOL,
      { pattern: "x" },
      { pluginPath: "C:/plugins/rg", requiresBinaries: [{ name: "rg" }] }
    )
    expect(result.output).toBe("found")
    expect(checkWithConsentMock).toHaveBeenCalledWith(
      "ripgrep-tools",
      "cli:execute",
      expect.anything(),
      expect.objectContaining({ context: "executeCliTool" })
    )
    expect(detectCliMock).toHaveBeenCalledWith("rg", undefined)
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin_cli_exec",
      expect.objectContaining({
        request: expect.objectContaining({
          program: "C:/bin/rg.exe",
          // cwd policy "workspace" resolved through the project store seam.
          cwd: "C:/work/repo",
        }),
      })
    )
    expect(auditAddMock).toHaveBeenCalled()
  })

  it("routes plugin-dir binaries through the real policy seam", async () => {
    const pluginDirTool: PluginCliToolDef = {
      ...TOOL,
      cwd: undefined,
      binary: { kind: "plugin-dir", relPath: "bin/tool.exe" },
    }
    await executeCliTool(
      "ripgrep-tools",
      pluginDirTool,
      { pattern: "x" },
      { pluginPath: "C:/plugins/rg", requiresBinaries: [], publisherFingerprint: "FP" }
    )
    expect(evaluateCliBinaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "ripgrep-tools",
        binaryPath: "C:/plugins/rg/bin/tool.exe",
        publisherFingerprint: "FP",
      })
    )
  })
})
