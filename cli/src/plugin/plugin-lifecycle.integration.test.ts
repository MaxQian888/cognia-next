/**
 * @jest-environment node
 *
 * Headless integration for the `/plugin update` path: drives the controller's
 * REAL default `refetch` seam (which imports `installFromGithubRef`) against a
 * mocked GitHub contents API and a real `plugin-origins.json` on a tmpdir —
 * the part unit tests stub out. Verifies the bundle is re-downloaded, the
 * fingerprint changes when content changes, and provenance is persisted.
 *
 * The live TUI additionally hot-reloads the module; that hop is injected here
 * (`reload`) because it needs the singleton PluginManager + Ink runtime.
 */
import os from "node:os"
import path from "node:path"
import nodeFs from "node:fs"
import nodeFsP from "node:fs/promises"

import { pluginUpdate } from "../tui/runtime/plugin-controller"
import { recordOrigin, getOrigin } from "./plugin-origins"
import type { TuiAction } from "../tui/state/types"

type Node = string | Array<{ type: "file" | "dir"; path: string }>

function installFetch(getTree: () => Record<string, Node>): void {
  ;(globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
    const m = String(url).match(/contents\/(.*?)(\?|$)/)
    const p = decodeURIComponent(m ? m[1] : "")
    const node = getTree()[p]
    if (node === undefined)
      return { status: 404, ok: false, json: async () => ({}) } as unknown as Response
    if (typeof node === "string") {
      return {
        status: 200,
        ok: true,
        json: async () => ({ type: "file", content: Buffer.from(node).toString("base64") }),
      } as unknown as Response
    }
    return { status: 200, ok: true, json: async () => node } as unknown as Response
  })
}

const manifestText = (version: string) =>
  JSON.stringify({ id: "demo.plugin", name: "Demo", version, type: "frontend", main: "main.js" })

describe("plugin update — real refetch + origins store", () => {
  const realFetch = globalThis.fetch
  let home: string
  beforeEach(() => {
    home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-update-"))
  })
  afterEach(async () => {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
    await nodeFsP.rm(home, { recursive: true, force: true })
  })

  it("re-downloads a changed bundle, bumps the version, and persists provenance", async () => {
    // Seed: pretend v1.0.0 was installed earlier (record an origin with a stale fingerprint).
    recordOrigin(home, "demo.plugin", {
      repoRef: "owner/repo",
      version: "1.0.0",
      fingerprint: "stale",
    })

    // Upstream now serves v2.0.0 with new file content.
    const version = "2.0.0"
    installFetch(() => ({
      "plugin.json": manifestText(version),
      "": [
        { type: "file", path: "plugin.json" },
        { type: "file", path: "main.js" },
      ],
      "main.js": `export default { v: "${version}" }`,
    }))

    const actions: TuiAction[] = []
    const reloaded: string[] = []
    await pluginUpdate("demo.plugin", {
      roots: [home],
      home,
      dispatch: (a) => actions.push(a),
      reload: async (id) => void reloaded.push(id),
    })

    // Re-downloaded to disk.
    expect(nodeFs.existsSync(path.join(home, ".cognia", "plugins", "demo.plugin", "main.js"))).toBe(
      true
    )
    // Hot-reload was requested for the right id.
    expect(reloaded).toEqual(["demo.plugin"])
    // Provenance updated to the new version + a real fingerprint (not "stale").
    const origin = getOrigin(home, "demo.plugin")
    expect(origin?.version).toBe("2.0.0")
    expect(origin?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    // Notice reports the bump.
    expect((actions[0] as { message: string }).message).toContain("v1.0.0 → v2.0.0")
  })

  it("check-all reports an available update for a stale origin", async () => {
    recordOrigin(home, "demo.plugin", { repoRef: "owner/repo", version: "1.0.0", fingerprint: "x" })
    installFetch(() => ({
      "plugin.json": manifestText("3.0.0"),
      "": [{ type: "file", path: "plugin.json" }],
    }))
    const actions: TuiAction[] = []
    await pluginUpdate("", { roots: [home], home, dispatch: (a) => actions.push(a) })
    expect((actions[0] as { message: string }).message).toMatch(
      /Updates available.*demo\.plugin.*3\.0\.0/
    )
  })
})
