/**
 * @jest-environment jsdom
 * @cognia-host-integration-test
 */
// Checked against the host's own icons bridge and `<FileTypeIcon>`, because the
// plugin ships no code of its own: everything it does is the manifest plus the
// public mirror, and the only proof that they line up is the real consumer.
import { existsSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"
import { createElement } from "react"
import { cleanup, render } from "@testing-library/react"

import { FileTypeIcon } from "@/components/shared/file-type-icon"
import {
  getActiveIconTheme,
  registerIconThemesForPlugin,
  unregisterIconThemesByPlugin,
  type VsCodeIconThemeData,
} from "@/lib/plugin/bridge/icons-bridge"
import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import definition, { manifest as moduleManifest } from "./index"
import manifest from "../plugin.json"

const PUBLIC_ROOT = join(__dirname, "../../../public")
const MIRROR_ROOT = join(PUBLIC_ROOT, "plugins", manifest.id)
const BUILTIN_ROOT = `builtin://${manifest.id}`
const [themeEntry] = manifest.vscodeIconThemes

function readTheme(): VsCodeIconThemeData {
  return JSON.parse(readFileSync(join(MIRROR_ROOT, themeEntry.path), "utf8")) as VsCodeIconThemeData
}

/** `iconPath` is relative to the theme JSON's directory, like VS Code resolves it. */
function mirrorRelative(iconPath: string): string {
  return posix.normalize(posix.join(posix.dirname(themeEntry.path), iconPath))
}

describe("cognia-material-icon-theme", () => {
  it("declares its icon theme through the field the plugin manager registers", () => {
    expect(manifest.type).toBe("frontend")
    expect(manifest.capabilities).toEqual(["themes"])
    expect(manifest.vscodeIconThemes).toEqual([
      { id: "material-icon-theme", label: "Material Icon Theme", path: "dist/material-icons.json" },
    ])
    expect(manifest.runtimeCompatibility).toMatchObject({
      browser: { availability: "supported" },
      tauri: { availability: "supported" },
      mobile: { availability: "supported" },
      headless: { availability: "blocked" },
    })
  })

  it("stays off until the user enables it", () => {
    // No `startup` (or any other) activation event: the manager's restore pass
    // only enables it once the user has recorded an `enabled` intent.
    const raw = manifest as Record<string, unknown>
    expect(raw.activationEvents).toBeUndefined()
    expect(raw.activateOnStartup).toBeUndefined()
    const merged = definition.manifest as unknown as Record<string, unknown>
    expect(merged.activationEvents).toBeUndefined()
  })

  it("credits the upstream project and ships its MIT license beside the assets", () => {
    expect(manifest.license).toBe("MIT")
    expect(manifest.author.name).toContain("Material Extensions")
    expect(manifest.repository).toBe(
      "https://github.com/material-extensions/vscode-material-icon-theme"
    )
    for (const licensePath of [join(MIRROR_ROOT, "LICENSE"), join(__dirname, "../LICENSE")]) {
      const text = readFileSync(licensePath, "utf8")
      expect(text).toContain("The MIT License (MIT)")
      expect(text).toContain("Copyright (c) 2025 Material Extensions")
      expect(text).toContain("The above copyright notice and this permission notice shall be")
    }
  })

  it("mirrors the theme JSON and every icon it references, all inside the plugin's own folder", () => {
    const theme = readTheme()
    const definitions = Object.entries(theme.iconDefinitions ?? {})
    expect(definitions.length).toBeGreaterThan(1000)
    const missing: string[] = []
    for (const [id, def] of definitions) {
      expect(def.iconPath).toEqual(expect.any(String))
      const rel = mirrorRelative(def.iconPath!)
      // Confinement: `..` past the theme dir must never leave the mirror.
      expect(rel.startsWith("../")).toBe(false)
      if (!existsSync(join(MIRROR_ROOT, rel))) missing.push(`${id} → ${rel}`)
    }
    expect(missing).toEqual([])
    // The icon manifest's own entry (plugin card avatar) is one of them.
    expect(manifest.icon).toBe(`/plugins/${manifest.id}/icons/folder-theme.svg`)
    expect(existsSync(join(MIRROR_ROOT, "icons/folder-theme.svg"))).toBe(true)
  })

  describe("enabled → FileTypeIcon, disabled → built-in glyphs", () => {
    let fetchSpy: jest.SpiedFunction<typeof fetch>

    beforeEach(() => {
      // The plugin's own teardown, the same call the manager makes on disable —
      // not a host-internal reset of every theme in the registry.
      unregisterIconThemesByPlugin(manifest.id)
      // Serve the static export exactly as the shells do: `/plugins/<id>/…`
      // is a file under `public/` (copied to `out/`).
      fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input)
        const file = join(PUBLIC_ROOT, decodeURIComponent(url))
        if (!url.startsWith("/plugins/") || !existsSync(file)) {
          return new Response("not found", { status: 404 })
        }
        return new Response(readFileSync(file, "utf8"), { status: 200 })
      })
    })

    afterEach(() => {
      cleanup()
      fetchSpy.mockRestore()
      unregisterIconThemesByPlugin(manifest.id)
    })

    it("renders the mirrored Material icons while registered and lucide glyphs after", async () => {
      const result = await registerIconThemesForPlugin(
        manifest.id,
        manifest.vscodeIconThemes,
        BUILTIN_ROOT
      )
      expect(result).toEqual({ registered: 1, errors: [] })
      expect(fetchSpy).toHaveBeenCalledWith(`/plugins/${manifest.id}/dist/material-icons.json`)
      expect(getActiveIconTheme()?.id).toBe(`${manifest.id}.material-icon-theme`)

      const cases: Array<[string, string]> = [
        ["src/app.tsx", "icons/react_ts.svg"],
        ["package.json", "icons/nodejs.svg"],
        // Material keys file names in lower case; VS Code matches them
        // case-insensitively, so the capitalised conventions must hit too.
        ["notes/README.md", "icons/readme.svg"],
        ["Dockerfile", "icons/docker.svg"],
        ["unknown.zzz-no-such-ext", "icons/file.svg"],
      ]
      for (const [path, icon] of cases) {
        const { container, unmount } = render(createElement(FileTypeIcon, { path }))
        const img = container.querySelector("img")
        expect(img).toHaveAttribute("src", `/plugins/${manifest.id}/${icon}`)
        expect(existsSync(join(MIRROR_ROOT, icon))).toBe(true)
        expect(container.querySelector("[data-file-type]")).toBeNull()
        unmount()
      }

      // Folders keep the built-in glyph even while the theme is active.
      const folder = render(createElement(FileTypeIcon, { path: "src", isDir: true }))
      expect(folder.container.querySelector("img")).toBeNull()
      folder.unmount()

      expect(unregisterIconThemesByPlugin(manifest.id)).toBe(1)
      const { container } = render(createElement(FileTypeIcon, { path: "src/app.tsx" }))
      expect(container.querySelector("img")).toBeNull()
      expect(container.querySelector("[data-file-type]")).toHaveAttribute("data-file-type", "react")
    })
  })

  it("exports plugin.json itself as the module manifest and passes the host validator", () => {
    expect(moduleManifest).toBe(manifest)
    expect(definition.manifest).toBe(moduleManifest)
    expect(validatePluginManifest(moduleManifest).errors).toEqual([])
  })

  it("activates without imperative host work", async () => {
    const ctx = {} as Parameters<typeof definition.activate>[0]
    await expect(Promise.resolve(definition.activate(ctx))).resolves.toBeUndefined()
    expect(definition.deactivate).toBeUndefined()
  })
})
