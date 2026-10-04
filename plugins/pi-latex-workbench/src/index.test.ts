import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { createTestPluginContext } from "@cognia/plugin-sdk/testing"

import definition, { manifest as moduleManifest } from "./index"
import manifest from "../plugin.json"

const pluginRoot = resolve(__dirname, "..")

describe("cognia-pi-latex-workbench lifecycle entry", () => {
  it("adopts plugin.json verbatim, so no TypeScript overlay can shadow a manifest key", () => {
    // `builtinManifest()`-style module-over-JSON merges let a hand-written
    // subset silently win; this entry must stay the JSON itself.
    expect(moduleManifest).toBe(manifest)
    expect(definition.manifest).toBe(manifest)
  })

  it("registers nothing imperatively — every contribution is declarative", async () => {
    const { ctx, calls } = createTestPluginContext({ pluginId: manifest.id })
    await definition.activate(ctx)
    expect(calls).toEqual([])
    expect(definition.deactivate).toBeUndefined()
  })

  it("documents that main is build output the plugin needs before it can load", () => {
    expect(manifest.main).toBe("dist/index.js")
    const readme = readFileSync(join(pluginRoot, "README.md"), "utf8")
    expect(readme).toContain("pnpm exec node plugins/pi-latex-workbench/build.mjs")
    expect(readme).toContain("cannot load")
  })
})
