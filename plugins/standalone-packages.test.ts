/** @jest-environment jsdom */
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import JSZip from "jszip"
import { PluginLoader } from "@/lib/plugin/core/loader"
import { assertPluginManifestParity } from "@/lib/plugin/core/manifest-parity"
import { makeNodeFrontendImporter } from "@/cli/src/plugin/node-importer"
import { validatePluginManifest } from "@/lib/plugin/core/validation"
import type { Plugin, PluginManifest } from "@/types/plugin"

/** Exercise release ZIPs outside the checkout, without source aliases or node_modules. */
describe("first-party standalone distribution", () => {
  let isolatedRoot: string
  beforeAll(async () => {
    execFileSync(process.execPath, ["scripts/plugin/build-frontend-plugins.mjs"], {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 120_000,
    })
    isolatedRoot = await mkdtemp(path.join(tmpdir(), "cognia-independent-"))
  }, 150_000)
  afterAll(async () => {
    if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true })
  })

  it("loads every released frontend ZIP with manifest parity, named exports and packaged resources", async () => {
    const directories = await readdir(path.join(process.cwd(), "plugins"), { withFileTypes: true })
    const sourceManifests: PluginManifest[] = []
    for (const entry of directories.filter((entry) => entry.isDirectory())) {
      const source = await readFile(
        path.join(process.cwd(), "plugins", entry.name, "plugin.json"),
        "utf8"
      ).catch(() => undefined)
      if (source) {
        const manifest = JSON.parse(source) as PluginManifest
        if (manifest.type === "frontend") sourceManifests.push(manifest)
      }
    }
    expect(sourceManifests.length).toBeGreaterThan(50)
    for (const sourceManifest of sourceManifests) {
      const archive = await JSZip.loadAsync(
        await readFile(
          path.join(
            process.cwd(),
            "dist/plugins",
            `${sourceManifest.id}-${sourceManifest.version}.zip`
          )
        )
      )
      const manifest = JSON.parse(
        await archive.file("plugin.json")!.async("string")
      ) as PluginManifest
      const validation = validatePluginManifest(manifest)
      expect({ id: manifest.id, errors: validation.errors }).toEqual({
        id: manifest.id,
        errors: [],
      })
      const root = path.join(isolatedRoot, manifest.id)
      for (const file of Object.values(archive.files).filter((file) => !file.dir)) {
        const destination = path.join(root, file.name)
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, await file.async("nodebuffer"))
      }
      const loader = new PluginLoader({ frontendImporter: makeNodeFrontendImporter() })
      const definition = await loader.load({
        manifest,
        path: root,
        source: "local",
        status: "installed",
        config: {},
      } as Plugin)
      expect(() => assertPluginManifestParity(manifest, definition.manifest)).not.toThrow()
      expect(definition.manifest.id).toBe(manifest.id)
      // IDE provider-only fixtures intentionally export handlers without an activation hook.
      if (!manifest.ide) expect(typeof definition.activate).toBe("function")
      for (const extension of manifest.extensions ?? []) {
        const exports = (await loader.importEntry(
          path.join(root, extension.entry),
          manifest.id,
          root
        )) as Record<string, unknown>
        expect(typeof exports[extension.export]).toBe("function")
      }
      if (manifest.styles)
        expect((await readFile(path.join(root, manifest.styles), "utf8")).length).toBeGreaterThan(
          20
        )
      if (manifest.icon?.startsWith("assets/")) expect(archive.file(manifest.icon)).not.toBeNull()
      await loader.unload(manifest.id)
    }
  }, 150_000)
})
