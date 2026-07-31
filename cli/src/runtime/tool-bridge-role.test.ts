/**
 * @jest-environment node
 */
import path from "node:path"
import { pathToFileURL } from "node:url"

import { runToolBridgeRole } from "./tool-bridge-role"
import { selectRole } from "../cli/role"

describe("selectRole", () => {
  it("routes the external agent's spawn to the tool bridge", () => {
    expect(selectRole({ COGNIA_ROLE: "tool-bridge" })).toBe("tool-bridge")
  })

  it("keeps the existing sidecar and default CLI roles", () => {
    expect(selectRole({ COGNIA_ROLE: "sidecar" })).toBe("sidecar")
    expect(selectRole({})).toBe("cli")
    expect(selectRole({ COGNIA_ROLE: "something-else" })).toBe("cli")
  })
})

describe("runToolBridgeRole", () => {
  it("imports the resolved bridge bundle as a file URL", async () => {
    const imported: string[] = []
    await runToolBridgeRole({
      resolveScript: () => "/repo/sidecar/cognia-tool-bridge.mjs",
      importer: async (url) => {
        imported.push(url)
      },
    })
    expect(imported).toEqual([pathToFileURL("/repo/sidecar/cognia-tool-bridge.mjs").href])
  })

  it("propagates a resolution failure instead of starting a half-wired bridge", async () => {
    await expect(
      runToolBridgeRole({
        resolveScript: () => {
          throw new Error("bridge missing")
        },
        importer: async () => undefined,
      })
    ).rejects.toThrow("bridge missing")
  })
})

describe("runToolBridgeRole — default seams", () => {
  it("imports through the real dynamic-import seam when none is injected", async () => {
    // A dependency-free sidecar module stands in for the bridge, so the default
    // importer is genuinely exercised without starting an MCP loop.
    const harmless = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "sidecar",
      "builtin-tools",
      "read-only-timeout.mjs"
    )
    await expect(runToolBridgeRole({ resolveScript: () => harmless })).resolves.toBeUndefined()
  })

  it("locates the in-repo bridge when no resolver is injected", async () => {
    const imported: string[] = []
    await runToolBridgeRole({
      importer: async (url) => {
        imported.push(url)
      },
    })
    expect(imported).toHaveLength(1)
    expect(imported[0].endsWith("sidecar/cognia-tool-bridge.mjs")).toBe(true)
  })
})
