/**
 * @jest-environment node
 */
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
