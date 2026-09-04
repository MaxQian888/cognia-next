/**
 * @jest-environment node
 */
import path from "node:path"
import { spawnSync } from "node:child_process"
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
  // In a separate process, because Jest's CommonJS transform rewrites the
  // default importer's `import(url)` into `require(url)`, which cannot load an
  // `.mjs` at all. Asserting that failure here would be asserting the test
  // transform. See `fixtures/tool-bridge-import-probe.ts`.
  it("imports through the real dynamic-import seam when none is injected", () => {
    const fixture = path.join(__dirname, "fixtures", "tool-bridge-import-probe.ts")
    const result = spawnSync(process.execPath, ["--import", "tsx", fixture], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout) as { ok: boolean; message?: string }).toEqual({
      ok: true,
      resolved: null,
    })
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
